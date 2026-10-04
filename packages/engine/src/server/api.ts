// packages/engine/src/server/api.ts
//
// The engine-side `/api/*` Hono routes. Read routes are thin handlers over the
// Storage handle; the write routes parse and guard the request, then call the
// same operations the CLI calls. The webapp reaches these routes in-process via
// `app.request()`: never replace that with a loopback fetch, which would
// serialize twice inside one binary.
//
// Write routes are defended by an Origin/Host same-origin check, a required
// `application/json` content type, and a body-size cap, and every write goes
// through the operations layer, whose single write seam validates the whole
// envelope.

import {
  DEFAULT_BIND_HOST,
  DEFAULT_QUERY_LIMIT,
  FILES_MAX,
  featureDisabledMessage,
  featureEnabled,
  ID_RE,
  isServedHostname,
  LIMIT_MAX,
  type PlatformInfo,
  REQUIREMENT_STATUSES,
  type RequirementStatus,
  type Storage,
} from "@spec-engine/shared";
import type { Context, Hono } from "hono";
import { listDomainKeys, normalizeDomainKey } from "../authoring/domains";
import { derivePlatformVersion, platformMode, platformName } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { type OpFailure, STATUS_FOR_REASON } from "../operations/_result";
import { accept } from "../operations/accept";
import { type AmendFields, amend } from "../operations/amend";
import { deprecate } from "../operations/deprecate";
import { mint } from "../operations/mint";
import {
  coverageMatrix,
  coverageReport,
  propagation,
  provenance,
  query,
  relations,
  reqTags,
} from "../operations/reads";
import { getRecord, listRecords } from "../operations/records";
import { supersede } from "../operations/supersede";
import { renderProvenanceDecorated } from "../provenance/format";
import { resolveAndCache } from "../provenance/resolve";
import { renderRelations, sortRelations } from "../relations/format";
import { sortReqTags } from "../resolve/format";
import { describeStorageError } from "../storage/errors";

/**
 * Strict positive-integer shape, the same contract the CLI applies to
 * `--limit`. `Number.parseInt` is too permissive (`"10abc"` → 10).
 */
const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

// LIMIT_MAX / DEFAULT_QUERY_LIMIT (the `?limit=` ceiling + default, shared with
// the CLI and MCP front-ends) are imported from @spec-engine/shared.
// FILES_MAX is imported from @spec-engine/shared so
// the CLI seam (commands/resolve.ts), HTTP seam (this file), and storage
// seam (storage/sqlite.ts resolveByFiles defense-in-depth check) share a
// single constant. A future bump only touches @spec-engine/shared.

/**
 * Path-shape predicate for `/api/resolve`. A traversal hazard is
 * `..` as a path SEGMENT (separated by `/` OR `\`), not as a substring.
 * Substring checks over-reject legitimate file names like
 * `my..thing/file.ts` or `version..1.2.ts`. Mirrored by the storage seam's
 * platform-relative invariant (T-5-03-02).
 *
 * Also split on `\` so Windows-style traversal segments
 * (`..\..\etc\passwd`) are caught alongside POSIX (`../../etc/passwd`).
 * CI runs darwin-arm64 but the storage seam compares tag paths byte-for-byte,
 * so the cross-platform inconsistency would otherwise let a Windows caller
 * silently get `[]` instead of a clean 400.
 */
function hasTraversalSegment(p: string): boolean {
  return p.split(/[/\\]/).some((seg) => seg === "..");
}

/**
 * Cross-platform absolute-path predicate. The previous
 * `f.startsWith("/")` check only blocked POSIX absolutes; Windows callers
 * could submit `C:\Windows\...` or a UNC-style `\\server\share` and pass
 * the shape guard (then silently no-match the storage seam). Reject:
 *   - leading `/` (POSIX absolute)
 *   - leading `\` (Windows root-relative or UNC prefix)
 *   - drive-letter prefixes like `C:\foo` or `C:/foo`
 */
function hasAbsoluteShape(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * `/api/resolve?req=KEY-NNN` — the reverse of the files→requirements resolve,
 * mirroring the CLI's `spec resolve --req` (T8). Emits the ReqTagRow shape
 * `{ req_id, repo, file, line, kind, level }` (Tag minus the AUTOINCREMENT id),
 * sorted through the SAME `sortReqTags` the CLI renders through so the HTTP and
 * CLI surfaces are byte-identical. An unknown id is `[]` + 200 (not 404) — same
 * as the CLI, which exits 0 with `[]`. `req` and `files` are mutually exclusive.
 */
function resolveByReq(c: Context, storage: Storage, reqParam: string): Response {
  if ((c.req.queries("files") ?? []).length > 0) {
    return c.json({ error: "pass either req or files, not both" }, 400);
  }
  if (!ID_RE.test(reqParam)) {
    return c.json({ error: "req must be a requirement id (KEY-NNN)" }, 400);
  }
  const { rows } = reqTags(storage, reqParam);
  return c.json(sortReqTags(rows));
}

/**
 * Storage backstop: wrap a route handler so an OPERATIONAL SQLite failure
 * (locks denied under a sandbox, cross-process SQLITE_BUSY, corrupt cache —
 * see storage/errors.ts) becomes a structured 503 `{error:
 * "storage_unavailable", code, hint}` instead of Hono's bare-text 500. Two
 * audiences: the SSR pages surface the hint as a readable error page rather
 * than choking on a non-JSON body, and agents driving the API get a named
 * cause they can act on. Anything the classifier does NOT recognize (our own
 * SQL bugs, plain Errors) re-throws unchanged — never silently
 * swallow.
 *
 * This is a per-HANDLER wrapper, not a `try { await next() }` middleware,
 * because Hono's compose catches a thrown handler at the innermost dispatch
 * level and hands it straight to the app-global `onError` — upstream
 * middleware never sees it. And it is not an `app.onError` because that is a
 * single app-wide slot the webapp's SSR error boundary also needs (last
 * registration would silently win — see webapp pages/data.ts).
 */
function guarded<C extends Context>(
  handler: (c: C) => Response | Promise<Response>,
): (c: C) => Promise<Response> {
  return async (c: C): Promise<Response> => {
    try {
      return await handler(c);
    } catch (err) {
      const info = describeStorageError(err);
      if (info === null) throw err;
      console.error(`spec serve: /api storage unavailable (${info.code}):`, err);
      return c.json({ error: "storage_unavailable", code: info.code, hint: info.hint }, 503);
    }
  };
}

/**
 * VAL-03 / T-21-04: upper bound on a write request body. A requirement
 * statement + why is a few hundred bytes; 64 KiB is generous headroom while
 * still rejecting a DoS-scale payload BEFORE it is parsed. Enforced against
 * both the `Content-Length` header (fast reject) and the actual read length
 * (defense-in-depth against a missing/lying header).
 */
const MAX_WRITE_BODY_BYTES = 64 * 1024;

/**
 * 2.6: in-process write serialization. `POST /api/requirements` does
 * read → compute-next-id → write → reindex with no locking, so two concurrent
 * POSTs could both read the same max seq and mint the SAME id. A single local
 * server needs nothing heavier than a promise chain: each write awaits the
 * previous one's completion. `.then(fn, fn)` runs `fn` whether the prior link
 * resolved OR rejected (a failed write must not wedge the chain); the stored
 * link swallows errors so an unhandled rejection never escapes.
 */
let writeChain: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

/**
 * T-21-01 same-origin guard for the state-changing routes, plus a
 * DNS-rebinding Host pin (1.1). Two independent checks:
 *
 * 1. Host pin (unconditional): the server binds exactly one address
 *    (`bindHost`, commands/serve.ts), so a write whose own Host is neither a
 *    loopback name nor that address did not come from a page we served — it is
 *    a rebind (attacker DNS → the bound address, `Host: evil.example`). The Origin/Host same-origin check below
 *    cannot catch this because both headers are attacker-controlled and AGREE.
 *    The in-process `app.request()` forward synthesizes `http://localhost/…`,
 *    so it passes.
 * 2. Same-origin (only when an `Origin` header is present): its host MUST
 *    equal the request's own host. A cross-site browser form post carries a
 *    mismatched Origin and is rejected 403. The in-process forward sends NO
 *    Origin header, so it passes untouched.
 *
 * Returns a 403 Response on rejection, or `null` to proceed.
 */
function rejectCrossOrigin(c: Context, bindHost: string): Response | null {
  const selfUrl = new URL(c.req.url);
  if (!isServedHostname(selfUrl.hostname, bindHost)) {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }
  const origin = c.req.header("origin");
  if (origin === undefined) return null;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }
  if (originHost !== selfUrl.host) {
    return c.json({ error: "cross-origin request rejected" }, 403);
  }
  return null;
}

/**
 * Shared header preflight for POST/PUT: require `application/json` and reject
 * an over-cap `Content-Length` (T-21-04) before the body is read. Returns a
 * rejection Response, or `null` to proceed.
 */
function rejectBadWriteHeaders(c: Context): Response | null {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    return c.json({ error: "content-type must be application/json" }, 415);
  }
  const clen = c.req.header("content-length");
  if (clen !== undefined && Number(clen) > MAX_WRITE_BODY_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }
  return null;
}

/**
 * Read + JSON-parse a write body with the body-size cap enforced on the actual
 * bytes (defense-in-depth beyond the Content-Length check). Returns the parsed
 * object, or a rejection Response (413 over-cap, 400 non-object / bad JSON).
 */
async function readJsonBody(
  c: Context,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; res: Response }> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, res: c.json({ error: "invalid request body" }, 400) };
  }
  // Cap on BYTE length, not UTF-16 code units — a multibyte payload
  // (e.g. emoji / CJK) must not slip past a 64 KiB ceiling measured in `.length`.
  if (Buffer.byteLength(raw, "utf8") > MAX_WRITE_BODY_BYTES) {
    return { ok: false, res: c.json({ error: "request body too large" }, 413) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, res: c.json({ error: "invalid JSON body" }, 400) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, res: c.json({ error: "body must be a JSON object" }, 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Normalize the optional `livesIn` write field to the STOR-01 `string[]` shape:
 * a string becomes a single-element array, an array passes through, anything
 * else (or absent) becomes `[]`. Mirrors the `req.ts` / `amend.ts` recipe.
 */
function toLivesIn(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

/** A POST body's authored fields; anything absent or mistyped takes the empty value. */
function mintFieldsFromBody(body: Record<string, unknown>) {
  return {
    statement: typeof body.statement === "string" ? body.statement : "",
    why: typeof body.why === "string" ? body.why : "",
    livesIn: toLivesIn(body.livesIn),
    issue:
      typeof body.issue === "string" && body.issue.trim() !== "" ? body.issue.trim() : undefined,
    status: body.status === "draft" ? ("draft" as const) : ("active" as const),
  };
}

/** The amendable fields named in a PUT body, or null when it names none. */
function amendFieldsFromBody(body: Record<string, unknown>): AmendFields | null {
  const fields: AmendFields = {};
  if (typeof body.statement === "string") fields.statement = body.statement;
  if ("why" in body) fields.why = typeof body.why === "string" ? body.why : null;
  if ("livesIn" in body) fields.livesIn = toLivesIn(body.livesIn);
  return Object.keys(fields).length === 0 ? null : fields;
}

/** An operation's refusal as the HTTP response its reason maps to. */
function failureResponse(c: Context, failure: OpFailure): Response {
  if (failure.reason === "not_found") return c.json({ error: "not found" }, 404);
  if (failure.reason === "invalid_domain_file") {
    return failure.diagnostics
      ? c.json({ error: "INVALID_DOMAIN_FILE", diagnostics: failure.diagnostics }, 400)
      : c.json({ error: "INVALID_DOMAIN_FILE", detail: failure.detail }, 400);
  }
  return c.json({ error: failure.detail }, STATUS_FOR_REASON[failure.reason]);
}

/** The `/api/query` response: hits, or a sanitized 400 on an FTS5 grammar error. */
function searchFtsResponse(c: Context, storage: Storage, q: string, limit: number): Response {
  const r = query(storage, q, limit);
  return r.ok ? c.json(r.hits) : c.json({ error: r.detail }, 400);
}

/**
 * Parse + validate the `/api/query` `?limit=` value. The strict POSITIVE_INT_RE
 * shape check AND the LIMIT_MAX ceiling both emit the SAME
 * `limit must be a positive integer ≤ LIMIT_MAX` 400 they do inline today.
 * Returns the parsed integer, or the 400 rejection Response.
 */
function parseQueryLimit(
  c: Context,
  rawLimit: string,
): { ok: true; limit: number } | { ok: false; res: Response } {
  if (!POSITIVE_INT_RE.test(rawLimit)) {
    return {
      ok: false,
      res: c.json({ error: `limit must be a positive integer ≤ ${LIMIT_MAX}` }, 400),
    };
  }
  const limit = Number.parseInt(rawLimit, 10);
  if (limit > LIMIT_MAX) {
    return {
      ok: false,
      res: c.json({ error: `limit must be a positive integer ≤ ${LIMIT_MAX}` }, 400),
    };
  }
  return { ok: true, limit };
}

/**
 * Mount the read-only `/api/*` plane onto an existing Hono app and return
 * the same app for chainability. Seven GET routes, no state-changing
 * endpoints (T-5-03-05).
 *
 * `Cache-Control: no-store` middleware fires for every `/api/*` path so
 * browsers (and intermediaries) never cache a derived-index response
 * across reindexes — defensive against the "I ran spec index but the
 * webapp still shows stale rows" footgun. Registered BEFORE the route
 * handlers so it applies uniformly (RESEARCH Open Q5).
 *
 * V12 path-shape guard for `/api/resolve?files=`: the route does NOT have
 * access to `platformDir` (it only sees the Storage handle), so V12
 * path-containment is enforced at the CLI layer (commands/resolve.ts).
 * Here we enforce SHAPE — reject any file containing `..` or starting
 * with `/` — as defense-in-depth alongside the storage seam's
 * platform-relative invariant (T-5-03-02).
 *
 * `platformDir` is an OPTIONAL third param (default
 * `process.cwd()` so the existing 2-arg callers/tests are unchanged). It is
 * threaded ONLY into the `/api/provenance?resolve=1` decorated-text seam,
 * where `resolveAndCache` writes its tracker sidecar under
 * `<platformDir>/.spec-engine/`. The real-serve composer (`composeServeApp` in
 * commands/serve.ts) passes the resolved platformDir through; tests pass the
 * fixture clone. Resolution is engine-SIDE — the webapp reads the decorated
 * text and never imports `@spec-engine/tracker` (D-09).
 *
 * `bindHost` is the address `spec serve` bound; the write routes' Host pin
 * accepts it alongside the loopback names.
 *
 * @spec SERV-009
 * @spec SERV-010
 */
export function mountApi(
  app: Hono,
  storage: Storage,
  platformDir: string = process.cwd(),
  bindHost: string = DEFAULT_BIND_HOST,
): Hono {
  // No-store middleware — applies to every `/api/*` route below. Registered
  // before the handlers so the header is set even on 400/404 responses.
  //
  // Set the header BEFORE next() so it survives a thrown handler
  // (e.g. /api/query re-throwing a non-FTS5 error, or a prepared SELECT
  // throwing on a corrupted DB). Hono's default error handler emits a 500
  // — headers set before next() land on the eventual response regardless
  // of who produces the body. The previous "after next()" placement meant
  // the line was unreachable on throw, so 500s went out without no-store.
  //
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  // --- /api/coverage ------------------------------------------------------

  app.get(
    "/api/coverage",
    guarded((c) => c.json(coverageMatrix(storage).rows)),
  );

  // --- /api/repos ---------------------------------------------------------
  // The registered member repos (name, path, pinned spec version) — read-only,
  // straight off the derived DB. Backs the webapp Setup page's mapped-repos
  // view. Discovery-only hints (selfMember/ignore) are absent from stored rows.

  app.get(
    "/api/repos",
    guarded((c) => c.json(storage.listRepos())),
  );

  // --- /api/platform ------------------------------------------------------

  app.get("/api/platform", async (c) => {
    const version = await derivePlatformVersion(platformDir);
    const info: PlatformInfo = {
      version,
      name: platformName(platformDir),
      source: "derived",
      mode: platformMode(platformDir),
    };
    return c.json(info);
  });

  // --- /api/report ----------------------------------------------------------
  // W1: per-domain rollup over Active requirements — the shared
  // buildCoverageReport over the SAME coverage VIEW /api/coverage serves,
  // so the report can never disagree with the matrix.

  app.get(
    "/api/report",
    guarded((c) => c.json(coverageReport(storage).rows)),
  );

  // --- /api/requirements --------------------------------------------------

  app.get(
    "/api/requirements",
    guarded((c) => {
      const key = c.req.query("key");
      const statusRaw = c.req.query("status");

      if (
        statusRaw !== undefined &&
        !REQUIREMENT_STATUSES.includes(statusRaw as RequirementStatus)
      ) {
        return c.json({ error: `status must be one of ${REQUIREMENT_STATUSES.join("|")}` }, 400);
      }

      const status = statusRaw as RequirementStatus | undefined;
      return c.json(listRecords(storage, { key, status }).rows);
    }),
  );

  app.get(
    "/api/requirements/:id",
    guarded((c) => {
      const id = c.req.param("id") ?? "";
      const { row } = getRecord(storage, id);
      return row ? c.json(row) : c.json({ error: "not found" }, 404);
    }),
  );

  // --- POST /api/requirements (VAL-03 create) ----------------------------
  //
  // Create a requirement in the target domain's SPEC.json through the mint
  // operation, then re-derive the index. On a structural reject the route
  // returns the diagnostics the shared validator emits, unreshaped.
  app.post(
    "/api/requirements",
    guarded(async function createRequirement(c) {
      // The editor feature flag gates the whole write plane, not just the
      // form (D4a): off means these endpoints answer 404.
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const key = normalizeDomainKey(typeof body.key === "string" ? body.key : "");
      if (key === "" || !listDomainKeys(platformDir).includes(key)) {
        return c.json({ error: "unknown domain key" }, 400);
      }

      // The read → next-id → write → reindex section is serialized so two
      // concurrent POSTs can never mint the same id.
      return withWriteLock(async () => {
        const r = await mint({ platformDir, key, ...mintFieldsFromBody(body) });
        if (!r.ok) return failureResponse(c, r);
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id: r.id }, 201);
      });
    }),
  );

  // --- PUT /api/requirements/:id (VAL-03 amend) --------------------------
  //
  // Amend an existing requirement's statement/why/livesIn through the same
  // seam. The domain is resolved by `locateRequirement` scanning the enumerated
  // domain keys; only the provided fields are mutated (amend.ts semantics),
  // untouched fields stay byte-identical.
  app.put(
    "/api/requirements/:id",
    guarded(async function amendRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";

      return withWriteLock(async () => {
        const fields = amendFieldsFromBody(body);
        if (fields === null) {
          return c.json({ error: "nothing to amend — provide statement, why, or livesIn" }, 400);
        }
        const r = await amend({ platformDir, id, fields }, async (reqId) => {
          await runIndex({ platformDir, storage });
          return storage.listTags({ req_id: reqId });
        });
        if (!r.ok) return failureResponse(c, r);
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id }, 200);
      });
    }),
  );

  // --- POST /api/requirements/:id/supersede -------------------------------
  //
  // The lifecycle write: flip the Active entry to superseded, mint its
  // successor, and answer with the retag worklist, the same shape as
  // `spec supersede --json`. The operation re-indexes into this handle for the
  // worklist, so the index is current when the response goes out.
  app.post(
    "/api/requirements/:id/supersede",
    guarded(async function supersedeRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";
      if (!ID_RE.test(id)) return c.json({ error: "id must be a requirement id (KEY-NNN)" }, 400);
      const statement = typeof body.statement === "string" ? body.statement.trim() : "";
      if (statement === "") return c.json({ error: "statement is required (non-empty)" }, 400);

      return withWriteLock(async () => {
        const r = await supersede(
          {
            platformDir,
            id,
            statement,
            why: typeof body.why === "string" ? body.why : undefined,
            livesIn: "livesIn" in body ? toLivesIn(body.livesIn) : undefined,
            issue:
              typeof body.issue === "string" && body.issue.trim() !== ""
                ? body.issue.trim()
                : undefined,
          },
          async (reqId) => {
            await runIndex({ platformDir, storage });
            return storage.listTags({ req_id: reqId });
          },
        );
        if (!r.ok) return failureResponse(c, r);
        return c.json(
          {
            ok: true,
            old_id: r.oldId,
            new_id: r.newId,
            file: r.file,
            spec_version: r.specVersion,
            retag: r.retag,
          },
          201,
        );
      });
    }),
  );

  // --- POST /api/requirements/:id/deprecate -------------------------------
  //
  // End a requirement with a recorded reason; the answer lists the code tags
  // still bound to it, the same shape as `spec deprecate --json`.
  app.post(
    "/api/requirements/:id/deprecate",
    guarded(async function deprecateRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;
      const body = parsed.body;

      const id = c.req.param("id") ?? "";
      if (!ID_RE.test(id)) return c.json({ error: "id must be a requirement id (KEY-NNN)" }, 400);
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason === "") return c.json({ error: "reason is required (non-empty)" }, 400);

      return withWriteLock(async () => {
        const r = await deprecate({ platformDir, id, reason }, async (reqId) => {
          await runIndex({ platformDir, storage });
          return storage.listTags({ req_id: reqId });
        });
        if (!r.ok) return failureResponse(c, r);
        return c.json({ ok: true, id: r.id, file: r.file, reason: r.reason, sites: r.sites }, 200);
      });
    }),
  );

  // --- POST /api/requirements/:id/accept ---------------------------------
  //
  // Promote a Draft to Active, the same shape as `spec accept --json`.
  app.post(
    "/api/requirements/:id/accept",
    guarded(async function acceptRequirement(c) {
      if (!featureEnabled("editor")) {
        return c.json({ error: featureDisabledMessage("editor") }, 404);
      }
      const originReject = rejectCrossOrigin(c, bindHost);
      if (originReject) return originReject;
      const headerReject = rejectBadWriteHeaders(c);
      if (headerReject) return headerReject;
      const parsed = await readJsonBody(c);
      if (!parsed.ok) return parsed.res;

      const id = c.req.param("id") ?? "";
      if (!ID_RE.test(id)) return c.json({ error: "id must be a requirement id (KEY-NNN)" }, 400);

      return withWriteLock(async () => {
        const r = await accept({ platformDir, id });
        if (!r.ok) return failureResponse(c, r);
        await runIndex({ platformDir, storage });
        return c.json({ ok: true, id: r.id, file: r.file }, 200);
      });
    }),
  );

  // --- /api/propagation/:id ----------------------------------------------

  app.get(
    "/api/propagation/:id",
    guarded((c) => c.json(propagation(storage, c.req.param("id") ?? "").rows)),
  );

  // --- /api/query --------------------------------------------------------

  app.get(
    "/api/query",
    guarded((c) => {
      // D4a / @spec SERV-006: an OFF feature refuses EVERY surface — the read
      // API included, not just the page and the write plane.
      if (!featureEnabled("query")) {
        return c.json({ error: featureDisabledMessage("query") }, 404);
      }
      const q = (c.req.query("q") ?? "").trim();
      if (!q) {
        return c.json({ error: "q is required (non-empty FTS5 MATCH query)" }, 400);
      }

      const rawLimit = c.req.query("limit") ?? String(DEFAULT_QUERY_LIMIT);
      const parsedLimit = parseQueryLimit(c, rawLimit);
      if (!parsedLimit.ok) return parsedLimit.res;

      return searchFtsResponse(c, storage, q, parsedLimit.limit);
    }),
  );

  // --- /api/relations ------------------------------------------------------

  app.get(
    "/api/relations",
    guarded((c) => {
      // D4a / @spec SERV-006: OFF feature → 404, same as /api/query.
      if (!featureEnabled("relations")) {
        return c.json({ error: featureDisabledMessage("relations") }, 404);
      }
      // RED-17: ?format=mermaid serves the SAME engine formatter the CLI
      // renders through (relations/format.ts) — the webapp /relations page
      // reads this text seam because its import fence (D-09) forbids
      // importing @spec-engine/spec-engine directly. Default (no format) is the JSON
      // row projection, consistent with every other /api/* route.
      const format = c.req.query("format");
      if (format !== undefined && format !== "mermaid") {
        return c.json({ error: 'format must be "mermaid" when provided' }, 400);
      }
      const rows = relations(storage).rows;
      if (format === "mermaid") {
        return c.text(renderRelations(rows, "mermaid"));
      }
      return c.json(sortRelations(rows));
    }),
  );

  // --- /api/provenance -----------------------------------------------------

  app.get(
    "/api/provenance",
    guarded(async (c) => {
      // D4a / @spec SERV-006: OFF feature → 404, same as /api/query.
      if (!featureEnabled("provenance")) {
        return c.json({ error: featureDisabledMessage("provenance") }, 404);
      }
      // PWEB-01: ?resolve=1 serves the SAME shared decorator the CLI
      // `--resolve-issues` flag renders through (provenance/format.ts
      // renderProvenanceDecorated) after resolving issues ENGINE-SIDE via the
      // surface-layer resolveAndCache (provenance/resolve.ts — the only tracker
      // importer besides commands/). The webapp /provenance page reads this text
      // seam because its import fence (D-09) forbids importing @spec-engine/tracker.
      // Default (no resolve) is the JSON matrix projection, consistent with every
      // other /api/* route. This mirrors /api/relations?format=mermaid exactly.
      const resolveParam = c.req.query("resolve");
      if (resolveParam !== undefined && resolveParam !== "1") {
        return c.json({ error: 'resolve must be "1" when provided' }, 400);
      }
      const rows = provenance(storage).rows;
      if (resolveParam === "1") {
        // Resolution is engine-side. With no SPEC_TRACKER_TOKEN this degrades to
        // the bare ids + the token hint with NO network call (resolveAndCache is
        // no-throw and the adapter degrades to {ok:false}).
        const resolved = await resolveAndCache(rows, platformDir);
        return c.text(renderProvenanceDecorated(rows, resolved, "text"));
      }
      return c.json(rows);
    }),
  );

  // --- /api/provenance?issue= ---------------------------------------------
  // Bound reverse lookup. The issue id is a QUERY VALUE, not a path segment —
  // an opaque tracker id may contain any character (a `/` made the old
  // /api/provenance/:issue form unaddressable) and a first-class path for a
  // ticket contradicted the opacity doctrine (PROV-02: a ticket is a filter
  // value, never an address). Passed straight to storage.provenanceByIssue
  // (bound as `$issue`), never string-interpolated into SQL.

  app.get(
    "/api/provenance/by-issue",
    guarded((c) => {
      // D4a / @spec SERV-006: OFF feature → 404, same as /api/provenance.
      if (!featureEnabled("provenance")) {
        return c.json({ error: featureDisabledMessage("provenance") }, 404);
      }
      const issue = (c.req.query("issue") ?? "").trim();
      if (issue === "") return c.json({ error: "issue is required (non-empty)" }, 400);
      return c.json(provenance(storage, issue).rows);
    }),
  );

  // --- /api/resolve ------------------------------------------------------

  app.get(
    "/api/resolve",
    guarded((c) => {
      // Reverse mode (`?req=KEY-NNN`) mirrors the CLI's `spec resolve --req`
      // (T8): map a requirement to its tag sites instead of files → requirements.
      const reqParam = c.req.query("req");
      if (reqParam !== undefined) return resolveByReq(c, storage, reqParam);

      // Hono's c.req.queries(name) returns an array for repeated query params
      // (`?files=a&files=b` → ["a","b"]). Validated upstream by RESEARCH A3.
      const files = c.req.queries("files") ?? [];

      if (files.length === 0) {
        return c.json({ error: "files query is required (one or more)" }, 400);
      }

      // Cap the array length so a `?files=…&files=…` of arbitrary
      // size cannot blow past SQLITE_MAX_VARIABLE_NUMBER (32766) downstream
      // in storage.resolveByFiles. 1000 mirrors LIMIT_MAX for /api/query and
      // is more than any real platform-scale call needs. Same cap is
      // enforced at the CLI seam (commands/resolve.ts) so the contract holds
      // at every entry point.
      if (files.length > FILES_MAX) {
        return c.json({ error: `too many files (max ${FILES_MAX} per request)` }, 400);
      }

      // V12 path-shape guard (T-5-03-02): defense-in-depth alongside the
      // CLI's containment check. Rejecting `..` SEGMENTS (not substrings) and
      // leading `/` is sufficient at the HTTP layer because storage stores
      // tag files as platform-relative — an absolute or traversal path can
      // never match a real tag, but rejecting them up front gives the caller
      // a clear error instead of a silent empty result.
      //
      // Previously this was `f.includes("..")`, which over-rejected
      // legitimate file names like `my..thing/file.ts` or `version..1.2.ts`.
      // The actual traversal hazard is `..` as a path SEGMENT.
      for (const f of files) {
        if (hasTraversalSegment(f) || hasAbsoluteShape(f)) {
          return c.json(
            { error: "files must be platform-relative (no .. segments, no leading /)" },
            400,
          );
        }
      }

      return c.json(storage.resolveByFiles(files));
    }),
  );

  return app;
}
