// packages/engine/src/commands/serve.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SERV-019
// @spec SERV-023
//
// `spec serve [platformDir] [--port N] [--out path] [--host IP] [--token T] [--allow-writes]`
// composes the engine HTTP API plane (`mountApi`) and the webapp SSR pages
// (`mountWebapp`) onto a single Hono instance and binds Bun.serve to
// ${host}:${port}. The `--probe` mode is preserved verbatim so the
// compile-time asset-embedding smoke keeps passing.
//
// SECURITY (T-1-01 / T-5-05-01): the bind is ONE address, 127.0.0.1 unless
// --host names another. `bindHostRefusal` (server/lan.ts) admits only a
// literal loopback, RFC 1918, or 100.64.0.0/10 address — never a wildcard,
// hostname, or public IP — and the source-grep test in `serve.test.ts`
// asserts the all-zeros bind address NEVER appears in this file. A
// non-loopback bind is wrapped in `lanGate`: an access token (cookie after a
// one-time query-parameter exchange), the Host pin widened to exactly the
// bound address so DNS rebinding stays blocked, and read-only unless
// --allow-writes. --probe always binds loopback.
//
// V12 path-containment: `--out` is resolved relative to platformDir and
// MUST stay under platformDir — mirrors `commands/query.ts:113-121`.
//
// Storage lifecycle: real-serve mode keeps storage open for the process
// lifetime — there is NO try/finally close around the Bun.serve bind.
// The server is read-only, so the long-lived connection is safe; SIGINT
// terminates the process (and Bun closes the file descriptor) when the
// developer is done. Documented in RESEARCH § Anti-Patterns and accepted
// as T-5-05-05.
//
// D-08 grep-fence: this file does NOT import bun:sqlite. DB access goes
// through `openStorage` (Storage seam from @spec-engine/shared).

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_BIND_HOST, type Storage } from "@spec-engine/shared";
import { createApp, mountWebapp } from "@spec-engine/webapp/server";
import { defineCommand } from "citty";
import { Hono } from "hono";
import { EXIT, OUT_HELP, resolveDbPath } from "../constants";
import { assertSpecPlatform, platformName } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { maybePromptForOnboarding } from "../onboarding/prompt";
import { mountApi } from "../server/api";
import {
  bindHostRefusal,
  generateToken,
  isLoopbackAddress,
  type LanGateOptions,
  lanGate,
  pinnedTokenRefusal,
  urlHost,
} from "../server/lan";
import { openStorage } from "../storage/sqlite";
import { platformDirArg, resolvePlatformDir } from "./_args";
import { assertContainedPath, handleNotAPlatform, handleStorageUnavailable } from "./_shared";

/**
 * Compose the real-serve Hono app: engine `/api/*` + webapp SSR pages on a
 * FRESH `new Hono()`. Exported so tests can compose without going through
 * citty's `run` (which would otherwise block on Bun.serve). The citty run
 * handler calls this and then binds Bun.serve on 127.0.0.1.
 *
 * Note: we deliberately do NOT use `createApp()` (the probe factory) because that one already registers `/` with the placeholder —
 * `mountWebapp` would conflict. The real-serve app is purely composed.
 *
 * `platformDir` is threaded through to `mountApi` so the
 * `/api/provenance?resolve=1` decorated-text seam writes its tracker sidecar
 * under `<platformDir>/.spec-engine/`. Defaults to `process.cwd()` so existing
 * callers/tests that omit it are unchanged (mountApi degrades to cwd too).
 */
export function composeServeApp(
  storage: Storage,
  platformDir: string = process.cwd(),
  bindHost: string = DEFAULT_BIND_HOST,
): Hono {
  const app = new Hono();
  mountApi(app, storage, platformDir, bindHost);
  mountWebapp(app, bindHost, platformName(platformDir));
  return app;
}

function usageError(message: string): never {
  console.error(`spec serve: ${message}`);
  process.exit(EXIT.USAGE);
}

/**
 * The validated bind for this run: the --host address plus, on a
 * non-loopback address, the gate options (token from --token, then
 * SPEC_SERVE_TOKEN, then freshly generated). Exits 2 on a refused value.
 */
export function resolveBind(args: {
  host?: string | undefined;
  token?: string | undefined;
  allowWrites?: boolean | undefined;
}): { host: string; lan: LanGateOptions | null } {
  const host = args.host ?? DEFAULT_BIND_HOST;
  const hostRefusal = bindHostRefusal(host);
  if (hostRefusal !== null) usageError(hostRefusal);
  if (isLoopbackAddress(host)) return { host, lan: null };

  const pinned = args.token ?? process.env.SPEC_SERVE_TOKEN;
  if (pinned !== undefined) {
    const tokenRefusal = pinnedTokenRefusal(pinned);
    if (tokenRefusal !== null) usageError(tokenRefusal);
  }
  return {
    host,
    lan: {
      bindHost: host,
      token: pinned ?? generateToken(),
      allowWrites: args.allowWrites === true,
    },
  };
}

/**
 * The `--probe` mode, preserved verbatim (the asset-embedding smoke): bind an ephemeral port on 127.0.0.1, GET /, assert the body
 * contains the placeholder, exit. Extracted from `run` so the real-serve
 * branch stays under the biome cognitive-complexity ceiling; the two modes
 * are conceptually independent and share no state.
 *
 * @spec SERV-011
 * @spec SERV-012
 */
async function runProbe(): Promise<void> {
  const app = createApp();
  // SECURITY: hardcoded loopback (T-1-01 mitigation). Do NOT take a --host
  // arg; the probe lives only on the developer's own machine.
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: app.fetch,
  });

  // RED-14: the success-path exit lives BELOW the try/catch. With it
  // inside, the catch conflated "probe passed" with "probe crashed" the
  // moment process.exit is anything but a hard terminator (e.g. the
  // ExitError test stub) — the thrown exit-0 sentinel was swallowed and
  // re-raised as exit 1. Only the fetch/assert work is guarded.
  try {
    const url = `http://127.0.0.1:${server.port}/`;
    const res = await fetch(url);
    if (res.status !== 200) {
      console.error(`serve --probe FAILED: status was ${res.status}, expected 200`);
      server.stop();
      process.exit(EXIT.FAILURE);
    }
    const body = await res.text();
    if (!body.includes("Spec Engine — coming online")) {
      console.error(`serve --probe FAILED: body did not contain the placeholder string (D-14)`);
      server.stop();
      process.exit(EXIT.FAILURE);
    }
  } catch (err) {
    console.error("serve --probe FAILED:", err);
    server.stop();
    process.exit(EXIT.FAILURE);
  }
  console.log("serve --probe OK");
  server.stop();
  process.exit(EXIT.OK);
}

export const serveCommand = defineCommand({
  meta: {
    name: "serve",
    description:
      "Run the local webapp. Binds 127.0.0.1 on --port, or one private --host address behind an access token. --probe is the SERV-04 asset-embedding smoke.",
  },
  args: {
    platformDir: platformDirArg,
    port: {
      type: "string",
      default: "4000",
      description: "Port (default 4000; 0 = ephemeral).",
    },
    host: {
      type: "string",
      default: DEFAULT_BIND_HOST,
      description:
        "Address to bind (default 127.0.0.1). Only a literal loopback, RFC 1918, or 100.64.0.0/10 IP; a non-loopback address requires the printed access token and is read-only.",
    },
    token: {
      type: "string",
      description:
        "Pin the access token for a non-loopback --host (else SPEC_SERVE_TOKEN, else random). At least 16 of A-Z a-z 0-9 _ -.",
    },
    allowWrites: {
      type: "boolean",
      description: "On a non-loopback --host, permit editor writes and tracker resolution.",
    },
    out: {
      type: "string",
      description: OUT_HELP,
    },
    probe: {
      type: "boolean",
      description:
        "Smoke test: bind ephemeral port on 127.0.0.1 (ignores --host), GET /, assert body contains placeholder, exit.",
    },
    noPrompt: {
      type: "boolean",
      description:
        "Suppress interactive onboarding prompt for siblings missing spec-engine.member.json (defaults to NO_SPEC_CONFIG warning)",
    },
  },
  async run({ args }) {
    // --- Probe branch: preserved verbatim (see runProbe) -------------------
    if (args.probe) {
      await runProbe();
      return;
    }

    // --- Real-serve branch -------------------------------------------------

    // T-5-05-03: strict integer shape + 0..65535 range for --port. The CLI
    // does NOT accept negative or non-integer ports; the message is faithful
    // to what the parser actually requires.
    const rawPort = args.port ?? "0";
    if (!/^[0-9]+$/.test(rawPort)) {
      console.error("spec serve: --port must be an integer 0..65535");
      process.exit(EXIT.USAGE);
      return;
    }
    const port = Number.parseInt(rawPort, 10);
    if (port > 65535) {
      console.error("spec serve: --port must be an integer 0..65535");
      process.exit(EXIT.USAGE);
      return;
    }

    const { host, lan } = resolveBind(args);

    const platformDir = resolvePlatformDir(args);
    const outArg = args.out;
    // Resolve --out relative to platformDir (NOT cwd) — mirrors
    // commands/query.ts and commands/map.ts.
    const dbPath = resolveDbPath(platformDir, outArg);

    // V12 path-containment guard — mirrors commands/query.ts:113-121.
    //
    // The guard is unconditional. The default-path branch
    // (`join(platformDir, ".spec-engine", "index.sqlite")`) is trivially contained
    // today, but a future refactor that changes the default to e.g.
    // `XDG_CACHE_HOME/spec/<hash>.sqlite` would silently leak the
    // containment invariant with no test to catch it. One comparison per
    // invocation; cheap insurance against future default-path drift.
    if (outArg) assertContainedPath(dbPath, platformDir, "spec serve: --out");

    // RED-11 pre-flight: a non-platform dir must produce a friendly,
    // actionable message + exit 2 BEFORE mkdirSync/openStorage — not the
    // generic "failed to start" wrapper around the NotASpecPlatformError
    // runIndex would throw. Running the guard before any FS write also
    // means no stale `.spec-engine/` artifact is left behind to poison the next
    // invocation into serving an empty index. Mirrors commands/map.ts.
    try {
      assertSpecPlatform(platformDir);
    } catch (e) {
      handleNotAPlatform(e);
    }

    // INIT-13 pre-flight: interactive prompt for skipped siblings. Runs
    // BEFORE mkdirSync(.spec-engine) so the exit-1 n-path leaves no artefacts.
    // Inserted AFTER the --probe branch returns (lines 88-121) — probe
    // never triggers the prompt (T-10-W3). Suppressed in non-TTY /
    // --no-prompt contexts; falls through to the NO_SPEC_CONFIG warning in
    // those cases. Only `check` registers `--ci`, so `args.ci` would be undefined
    // here — drop the dead plumbing rather than forward `undefined`.
    await maybePromptForOnboarding({
      platformDir,
      args: {
        noPrompt: args.noPrompt,
      },
    });

    mkdirSync(dirname(dbPath), { recursive: true });

    // Capture existence BEFORE openStorage — openStorage creates the file
    // on demand. If the DB is missing, populate it via runIndex (transparent
    // re-index for read commands; same pattern as `spec query`).
    const needsIndex = !existsSync(dbPath);
    // Fail-fast diagnosis: openStorage takes the WAL locks, so a sandboxed
    // process (file locks denied → SQLITE_IOERR_VNODE) dies HERE with the
    // actionable one-liner instead of binding the port and 500ing on every
    // later request. Non-storage errors rethrow into citty as before.
    let storage: Storage;
    try {
      storage = openStorage(dbPath);
    } catch (err) {
      handleStorageUnavailable(err, dbPath);
      throw err;
    }

    // Storage is allocated above; runIndex and Bun.serve can both
    // throw before we reach "server lifetime keeps the FD open." If they
    // throw, close storage explicitly so WAL siblings are flushed before
    // process exit. Once Bun.serve returns successfully we hand storage
    // off to the server's process lifetime (T-5-05-05) and intentionally
    // do NOT close.
    let server: ReturnType<typeof Bun.serve>;
    try {
      if (needsIndex || storage.listRepos().length === 0) {
        // RED-16: the second disjunct catches the D-12 silent-rebuild case —
        // the DB file EXISTED (so needsIndex is false) but openStorage wiped
        // it because its _schema_version predated a SCHEMA_VERSION bump. An
        // indexed platform always has >= 1 repo row (the canonical), so an
        // empty repos table unambiguously means "no index here"; without
        // this, every read command emits empty output (exit 0) until the
        // user manually runs `spec index`.
        await runIndex({ platformDir, storage });
      }

      const app = composeServeApp(storage, platformDir, host);
      server = Bun.serve({
        port,
        hostname: host,
        fetch: lan === null ? app.fetch : lanGate(app.fetch, lan),
      });
    } catch (err) {
      storage.close();
      // Named-cause path first: a sandboxed/locked/corrupt index database
      // prints the storage/errors.ts hint + exits 1. The startup probe that
      // trips it is the listRepos()/runIndex read-write pass above — the
      // same locks every later request would need.
      handleStorageUnavailable(err, dbPath);
      console.error(`spec serve: failed to start on ${urlHost(host, port)}:`, err);
      process.exit(EXIT.FAILURE);
      // The explicit return makes the control-flow termination
      // local. `process.exit` is typed `never`, but if a future test harness
      // stubs it to record exits without throwing (or wraps run() in a
      // silent try/catch), the `server.port` access below would throw
      // TypeError on an unset `let server`. This `return` decouples
      // correctness from that non-local invariant.
      return;
    }

    // Do NOT close storage here — the server lifecycle outlives this run()
    // call (T-5-05-05). SIGINT releases the file descriptor.
    const serving = `spec: serving ${platformName(platformDir)} on ${server.url.origin}`;
    if (lan === null) {
      console.log(serving);
      return;
    }
    console.log(`${serving}/?token=${lan.token}`);
    console.log(lan.allowWrites ? "spec: writes ALLOWED (--allow-writes)" : "spec: read-only");
  },
});
