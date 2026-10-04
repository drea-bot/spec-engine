// packages/webapp/src/pages/editor.ts
//
// Plan 21-04 / VAL-03 (webapp tier) — a THIN SSR editor over the engine
// write route from plan 21-01. This page renders a create form and an amend
// form and, on submit, forwards the fields to the engine's state-changing
// routes IN-PROCESS via `app.request()`:
//
//   POST /editor/create → POST /api/requirements        (create)
//   POST /editor/amend  → PUT  /api/requirements/:id     (amend)
//
// The webapp stays hermetic (D-09 / WORK-04 / Invariant #5): this file
// imports ONLY `@spec-engine/shared` (types) + `hono` (runtime) + the local
// nav/styles. There is NO filesystem access, NO `@spec-engine/spec-engine` import, NO
// `@spec-engine/tracker`, NO `bun:sqlite`, and NO forked write/validation logic —
// every byte of the write path lives engine-side behind the ONE
// `validateAndWrite` seam (VAL-01). Invalid input is NOT re-validated here;
// the engine's `INVALID_DOMAIN_FILE` diagnostic is surfaced UNCHANGED
// (VAL-02 — one engine, byte-identical diagnostics).
//
// Forwarding rule (Pitfall 6): submits are forwarded via `app.request(...)`
// in-process — NEVER over a network port round-trip.
//
// CSRF (CR-01): the BROWSER posts to `/editor/create` and `/editor/amend` —
// NOT to `/api/requirements` — and the in-process forward deliberately carries
// no Origin header, so the engine's own Origin guard (T-21-01) can never see
// the browser request. The same-origin defense therefore MUST live HERE, on the
// browser-facing routes, or a drive-by-localhost page could auto-submit a
// form-urlencoded POST (a CORS "simple" request, no preflight) and mutate the
// local spec-engine. `crossOriginRejected` mirrors the engine guard; a
// `content-length` cap bounds the buffered body before parseBody (WR-01).
//
// Rendering shape — each handler returns a single self-contained
// `<!doctype html>` document via ONE `hono/html` tagged template so all
// echoed user text (statement/why/id) is auto-escaped (Pitfall 7 / T-21-05:
// no stored XSS). The `raw` helper is used ONLY for the static styles.css
// asset.

import {
  DEFAULT_BIND_HOST,
  type Diagnostic,
  featureDisabledMessage,
  featureEnabled,
  isServedHostname,
} from "@spec-engine/shared";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html, raw } from "hono/html";
import { comingSoonDoc } from "./components";
import { navBar } from "./nav";
import styleSheet from "./styles.css" with { type: "text" };

const styleTag = raw(`<style>${styleSheet}</style>`);

/** Editor POST body ceiling — mirrors the engine's MAX_WRITE_BODY_BYTES so the
 *  browser-facing route bounds the buffered body BEFORE parseBody (WR-01). */
const MAX_EDITOR_BODY_BYTES = 64 * 1024;

/**
 * CR-01 same-origin guard + DNS-rebinding Host pin (1.1) for the browser-facing
 * editor POSTs. Mirrors the engine's `rejectCrossOrigin`:
 *   1. Host pin (unconditional): `isServedHostname`.
 *   2. Same-origin: a present `Origin` whose host differs from the request host
 *      (or an unparseable Origin) is a cross-site post → reject.
 * A same-origin form post carries a matching Origin (or, for the in-process
 * `app.request` forward, none, and a `localhost` Host) and is allowed.
 */
function crossOriginRejected(c: Context, bindHost: string): boolean {
  const selfUrl = new URL(c.req.url);
  if (!isServedHostname(selfUrl.hostname, bindHost)) return true;
  const origin = c.req.header("origin");
  if (origin === undefined) return false;
  try {
    return new URL(origin).host !== selfUrl.host;
  } catch {
    return true;
  }
}

/**
 * 2.6: body-size cap enforced on ACTUAL bytes via Hono's `bodyLimit`, not the
 * declared `content-length` alone. The previous header-only check let a request
 * with an absent or malformed `Content-Length` bypass the cap entirely
 * (`NaN > cap` is false). `bodyLimit` uses the header as a fast reject when
 * present and otherwise streams + counts the real bytes, rebuilding the request
 * so the downstream `parseBody` still works. Mounted as middleware on the two
 * editor POST routes.
 */
const editorBodyLimit = bodyLimit({
  maxSize: MAX_EDITOR_BODY_BYTES,
  onError: (c) => c.html(rejectPage("request body too large"), 413),
});

/** Render a self-contained rejection page (no engine round-trip). */
function rejectPage(message: string): ReturnType<typeof html> {
  return page(
    "Rejected",
    html`
      ${navBar("editor")}
      <h1>Not saved</h1>
      <p class="error">${message}</p>
      <p><a href="/editor">Back to editor</a></p>
    `,
  );
}

/** Wrap a body fragment in the shared self-contained document shell. */
function page(title: string, body: ReturnType<typeof html>): ReturnType<typeof html> {
  return html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spec Engine — ${title}</title>
    ${styleTag}
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

/** Read a single string field from a parsed form body (ignores File values). */
function field(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  return typeof v === "string" ? v : "";
}

/**
 * Render the engine route's JSON response as an SSR result page. A 2xx
 * carries `{ ok, id }` → success (new/updated id). A non-2xx carries either
 * `{ error, diagnostics }` (INVALID_DOMAIN_FILE — surfaced UNCHANGED) or a
 * plain `{ error }` (unknown key/id, guard rejects). Nothing here is
 * re-validated or reshaped — the webapp only renders what the engine returned.
 */
async function renderResult(res: Response): Promise<ReturnType<typeof html>> {
  const data = (await res.json()) as {
    ok?: boolean;
    id?: string;
    error?: string;
    diagnostics?: Diagnostic[];
  };

  if (res.ok && data.ok) {
    return page(
      "Saved",
      html`
        ${navBar("editor")}
        <h1>Saved</h1>
        <p class="success">Requirement <code>${data.id}</code> was written.</p>
        <p><a href="/requirements/${encodeURIComponent(data.id ?? "")}">View requirement</a></p>
        <p><a href="/editor">Back to editor</a></p>
      `,
    );
  }

  const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
  return page(
    "Rejected",
    html`
      ${navBar("editor")}
      <h1>Not saved</h1>
      <p class="error">${data.error ?? "Write rejected."}</p>
      ${
        diagnostics.length > 0
          ? html`<ul>
              ${diagnostics.map((d) => html`<li><code>${d.code}</code> — ${d.detail}</li>`)}
            </ul>`
          : ""
      }
      <p><a href="/editor">Back to editor</a></p>
    `,
  );
}

/**
 * Mount the editor: `GET /editor` (create + amend forms), `POST /editor/create`
 * and `POST /editor/amend` (form-forward handlers). Each POST handler closes
 * over `app` so it forwards to the engine `/api/requirements` routes in-process.
 */
export function mountEditor(app: Hono, bindHost: string = DEFAULT_BIND_HOST): void {
  app.get("/editor", (c) => {
    if (!featureEnabled("editor")) return c.html(comingSoonDoc("editor", "Editor"));
    const body = html`
      ${navBar("editor")}
      <div class="eyebrow">/ Editor</div>
      <h1>Editor</h1>
      <p class="lede">
        Create or amend a requirement. Every write is forwarded in-process to the one engine
        validator — invalid input comes back with the engine's own diagnostics, unchanged.
      </p>

      <section>
        <h2>Create a requirement</h2>
        <form method="post" action="/editor/create">
          <label>
            Domain key
            <input type="text" name="key" placeholder="BILLING" required />
          </label>
          <label>
            Statement
            <textarea name="statement" rows="3" placeholder="When … then …"></textarea>
          </label>
          <label>
            Why (optional)
            <textarea name="why" rows="2"></textarea>
          </label>
          <label>
            Lives in (optional, single path)
            <input type="text" name="livesIn" placeholder="path/to/impl.ts" />
          </label>
          <button type="submit">Create</button>
        </form>
      </section>

      <section>
        <h2>Amend a requirement</h2>
        <form method="post" action="/editor/amend">
          <label>
            Requirement id
            <input type="text" name="id" placeholder="BILLING-002" required />
          </label>
          <label>
            New statement
            <textarea name="statement" rows="3"></textarea>
          </label>
          <label>
            New why (optional)
            <textarea name="why" rows="2"></textarea>
          </label>
          <button type="submit">Amend</button>
        </form>
      </section>
    `;
    return c.html(page("Editor", body));
  });

  app.post("/editor/create", editorBodyLimit, async (c) => {
    // Flag off means the endpoints are off too — hiding the form is not
    // turning the feature off (D4a).
    if (!featureEnabled("editor")) return c.html(rejectPage(featureDisabledMessage("editor")), 404);
    if (crossOriginRejected(c, bindHost))
      return c.html(rejectPage("cross-origin request rejected"), 403);
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const statement = field(form, "statement");
    const why = field(form, "why");
    const livesIn = field(form, "livesIn");

    // Build the create payload. `statement` passes through raw (even empty) so
    // an invalid value is rejected by the ONE engine validator (VAL-02), not a
    // forked check here. `why`/`livesIn` are omitted when blank so the engine
    // applies its own defaults (why→null, livesIn→[]), matching the CLI.
    const payload: Record<string, unknown> = {
      key: field(form, "key"),
      statement,
    };
    if (why.length > 0) payload.why = why;
    if (livesIn.length > 0) payload.livesIn = livesIn;

    const res = await app.request("/api/requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return c.html(await renderResult(res));
  });

  app.post("/editor/amend", editorBodyLimit, async (c) => {
    if (!featureEnabled("editor")) return c.html(rejectPage(featureDisabledMessage("editor")), 404);
    if (crossOriginRejected(c, bindHost))
      return c.html(rejectPage("cross-origin request rejected"), 403);
    const form = (await c.req.parseBody()) as Record<string, unknown>;
    const id = field(form, "id");
    const statement = field(form, "statement");
    const why = field(form, "why");

    // Only forward the fields the user actually filled in (amend semantics:
    // untouched fields stay byte-identical). An all-blank submit reaches the
    // engine with no amendable field and gets the engine's 400 unchanged.
    const payload: Record<string, unknown> = {};
    if (statement.length > 0) payload.statement = statement;
    if (why.length > 0) payload.why = why;

    const res = await app.request(`/api/requirements/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return c.html(await renderResult(res));
  });
}
