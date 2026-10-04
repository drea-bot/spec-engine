// packages/webapp/src/server.ts
//
// The webapp scaffold. The createApp() factory returns a Hono app that
// serves the placeholder page embedded at compile time via Bun's
// `import ... with { type: "text" }` attribute.
//
// IMPORTANT: do NOT switch to Bun.file("./index.html.txt") — that resolves at
// runtime and fails inside the `bun build --compile` binary.
// IMPORTANT: this package may NOT import bun:sqlite, node:fs, fs, bun,
// node:path, or anything from @spec-engine/spec-engine (enforced by D-09 lint).

import { DEFAULT_BIND_HOST } from "@spec-engine/shared";
import { Hono } from "hono";
import { html as htmlTemplate } from "hono/html";
// Bun inlines the file as a string when imported with the `text` attribute;
// the `.txt` extension is what types the import as a string, and
// `bun build --compile` embeds the raw file contents as UTF-8.
import html from "./index.html.txt" with { type: "text" };
import { mountCoverage } from "./pages/coverage";
import { registerErrorBoundary } from "./pages/data";
import { mountEditor } from "./pages/editor";
import { mountGlossary } from "./pages/glossary";
import { mountLogs } from "./pages/logs";
import { mountPropagation } from "./pages/propagation";
import { mountProvenance } from "./pages/provenance";
import { mountQuery } from "./pages/query";
import { mountRelations } from "./pages/relations";
import { mountRequirements } from "./pages/requirements";
import { mountSetup } from "./pages/setup";

/** The embedded HTML string — exported so the `serve --probe` smoke can
 *  assert the binary really inlined it (D-14). */
export const placeholderHtml = html;

export function createApp(): Hono {
  const app = new Hono();
  app.get("/", (c) => c.html(html));
  return app;
}

/**
 * Must be registered before the page routes for Hono to run it around them.
 *
 * @spec SERV-026
 */
function labelPlatform(app: Hono, platformName: string): void {
  const name = htmlTemplate`${platformName}`.toString();
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.get("content-type")?.startsWith("text/html")) return;
    const body = (await c.res.text())
      .replace("<title>Spec Engine", `<title>${name} · Spec Engine`)
      .replace(
        "<span>Spec Engine</span></a>",
        `<span>Spec Engine</span><span class="sidebar-platform">${name}</span></a>`,
      );
    const headers = new Headers(c.res.headers);
    headers.delete("content-length");
    c.res = new Response(body, { status: c.res.status, headers });
  });
}

/**
 * Mount the SSR pages onto an existing Hono app and return
 * the same app for chainability (RED-17 added /relations). Mirrors
 * `mountApi(app, storage)`'s "mutate-one-app" composition (RESEARCH Open
 * Q1) so `commands/serve.ts` can compose engine + webapp on
 * one Hono instance:
 *
 *   const app = new Hono();
 *   mountApi(app, storage);   // /api/*  (engine)
 *   mountWebapp(app);         // /, /requirements, /propagation/:id, /query, /relations, /provenance  (webapp)
 *
 * Each page handler closes over `app` so it can read its own `/api/*`
 * routes in-process via `app.request(path)` (never
 * `fetch("http://...")`).
 *
 * NOTE: `mountWebapp` registers `/` — do NOT call it on the app returned
 * by `createApp()` (the probe factory) because that one already
 * has `/` bound to the placeholder. The real-serve composer
 * builds a fresh `new Hono()` and calls both mount functions on it.
 */
export function mountWebapp(
  app: Hono,
  bindHost: string = DEFAULT_BIND_HOST,
  platformName?: string,
): Hono {
  if (platformName !== undefined) labelPlatform(app, platformName);
  // Error boundary first: a page whose API read fails (e.g. the engine's
  // storage layer is unavailable — sandboxed file locks, contention) renders
  // a readable error page with the engine's hint instead of Hono's bare-text
  // 500. See pages/data.ts.
  registerErrorBoundary(app);
  mountCoverage(app);
  mountRequirements(app);
  mountPropagation(app);
  mountQuery(app);
  mountRelations(app);
  mountProvenance(app);
  mountEditor(app, bindHost);
  mountSetup(app);
  mountGlossary(app);
  mountLogs(app);
  return app;
}
