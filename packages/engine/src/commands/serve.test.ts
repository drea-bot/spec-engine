// packages/engine/src/commands/serve.test.ts
//
// Dogfood (spec self-consumes this repo — see spec-engine/):
// @spec SERV-019
//
// Locks the CLI surface and the single-address bind for `spec serve`.
//
// Three test families:
//   1. SOURCE-GREP tests over `packages/engine/src/commands/serve.ts`:
//        a. The probe binds a hardcoded `hostname: "127.0.0.1"`; the real
//           serve binds the validated `host`, whose default is loopback.
//        b. The substring `0.0.0.0` never appears (case-sensitive).
//   2. REAL-SERVE in-process smoke: `composeServeApp(storage)` returns a
//      Hono that, bound on Bun.serve port 0 / 127.0.0.1, answers
//      `/api/coverage` with 200 (proves engine + webapp are composed).
//   3. CITTY ARGV validation: invoking the citty `run` handler with bad
//      --port and bad --out exits 2.
//
// The citty harness mirrors the ExitError pattern from
// cli-query-unit.test.ts so the test can assert exit codes without
// terminating the runner. Per-test cleanup uses `rmSync` against the
// per-test clone — never against `fixtures/platform-fixture/` (WR-06).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DEFAULT_BIND_HOST } from "@spec-engine/shared";
import { mountWebapp } from "@spec-engine/webapp/server";
import { Hono } from "hono";
import { platformName } from "../indexer/discover";
import { runIndex } from "../indexer/pipeline";
import { openStorage } from "../storage/sqlite";
import { cloneFixture } from "../testing/cloneFixture";
import { composeServeApp, resolveBind, serveCommand } from "./serve";

const FIXTURE = resolve(import.meta.dir, "..", "..", "..", "..", "fixtures", "platform-fixture");
const SERVE_SRC = resolve(import.meta.dir, "serve.ts");

// ---------- ExitError harness (mirrors cli-query-unit.test.ts) ----------

class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

let clone: string;
let logs: string[];
let errs: string[];
let originalLog: typeof console.log;
let originalErr: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(() => {
  clone = cloneFixture(FIXTURE);
  logs = [];
  errs = [];
  originalLog = console.log;
  originalErr = console.error;
  originalExit = process.exit;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  (process as unknown as { exit: (code?: number) => never }).exit = (code?: number) => {
    throw new ExitError(code ?? 0);
  };
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalErr;
  process.exit = originalExit;
  rmSync(clone, { recursive: true, force: true });
});

type RunFn = (ctx: { args: Record<string, unknown>; rawArgs: string[] }) => Promise<void>;
const serveRun = (serveCommand as unknown as { run: RunFn }).run;

async function runServe(args: Record<string, unknown>): Promise<number> {
  try {
    await serveRun({ args, rawArgs: [] });
    return 0;
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
}

// ---------- 1. Source-grep tests (T-5-05-01 defense-in-depth) ----------

describe("serve.ts source invariants (T-5-05-01 single-address bind)", () => {
  test("the probe binds hardcoded loopback; the real serve binds only the validated host", async () => {
    const src = await Bun.file(SERVE_SRC).text();
    const hostnames = [...src.matchAll(/hostname:\s*([^,\n]+)/g)].map((m) => m[1]);
    expect(hostnames).toEqual(['"127.0.0.1"', "host"]);
    expect(DEFAULT_BIND_HOST).toBe("127.0.0.1");
    expect(src).toContain("default: DEFAULT_BIND_HOST");
  });

  test("the substring 0.0.0.0 NEVER appears in serve.ts (defense in depth)", async () => {
    const src = await Bun.file(SERVE_SRC).text();
    expect(src.includes("0.0.0.0")).toBe(false);
  });
});

// ---------- 2. composeServeApp real-serve smoke ----------

// @spec SERV-011
describe("composeServeApp (real serve mode composition)", () => {
  test("composeServeApp(storage) returns a Hono that answers /api/coverage on 127.0.0.1", async () => {
    const dbPath = resolve(clone, ".spec-engine", "index.sqlite");
    const storage = openStorage(dbPath);
    await runIndex({ platformDir: clone, storage });

    // Phase 16 (PWEB-01): pass platformDir so the /api/provenance?resolve=1
    // seam writes its tracker sidecar under the clone, not the runner's cwd.
    const app = composeServeApp(storage, clone);
    // Bind ephemeral port 0 on loopback; assert the URL is 127.0.0.1:N.
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      expect(server.port).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/coverage`);
      expect(res.status).toBe(200);
      const rows = await res.json();
      expect(Array.isArray(rows)).toBe(true);
      // Smoke: the page that the SSR side renders for / also works.
      const indexRes = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(indexRes.status).toBe(200);
      const indexBody = await indexRes.text();
      expect(indexBody).toContain("BILLING-009");
    } finally {
      server.stop();
      storage.close();
    }
  });
});

describe("platform identity", () => {
  test("the API and every page name the platform from its platform file, never a path", async () => {
    // @spec SERV-026 integration
    const storage = openStorage(resolve(clone, ".spec-engine", "index.sqlite"));
    await runIndex({ platformDir: clone, storage });
    try {
      const app = composeServeApp(storage, clone);
      const info = (await (await app.request("/api/platform")).json()) as { name: string };
      expect(info.name).toBe("platform-fixture");
      const page = await (await app.request("/")).text();
      expect(page).toContain("<title>platform-fixture · Spec Engine");
      expect(page).toContain('<span class="sidebar-platform">platform-fixture</span>');
      expect(page).not.toContain(clone);
    } finally {
      storage.close();
    }
  });

  test("a directory with no platform file is named by its directory", () => {
    // @spec SERV-026 unit
    const dir = mkdtempSync(join(tmpdir(), "named-platform-"));
    try {
      expect(platformName(dir)).toBe(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the page label escapes the name", async () => {
    // @spec SERV-026 unit
    const app = mountWebapp(new Hono(), "127.0.0.1", "<b>x</b>");
    app.get("/probe", (c) => c.html("<title>Spec Engine</title>"));
    expect(await (await app.request("/probe")).text()).toBe(
      "<title>&lt;b&gt;x&lt;/b&gt; · Spec Engine</title>",
    );
  });
});

// ---------- 3. Citty argv validation (T-5-05-02, T-5-05-03) ----------

describe("serveCommand argv validation", () => {
  test("--port abc → stderr + exit 2 (T-5-05-03 non-integer)", async () => {
    const code = await runServe({ probe: false, port: "abc", platformDir: clone });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("--port");
  });

  test("--port -1 → exit 2 (T-5-05-03 negative)", async () => {
    const code = await runServe({ probe: false, port: "-1", platformDir: clone });
    expect(code).toBe(2);
  });

  test("--port 65536 → exit 2 (T-5-05-03 above range)", async () => {
    const code = await runServe({ probe: false, port: "65536", platformDir: clone });
    expect(code).toBe(2);
  });

  test("--out outside platformDir → exit 2 (T-5-05-02 path containment)", async () => {
    const code = await runServe({
      probe: false,
      port: "0",
      platformDir: clone,
      out: "../escape.sqlite",
    });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("--out");
  });
});

// ---------- RED-11: pre-index / pre-spec guidance ----------

describe("serveCommand --host / --token", () => {
  test.each(["0.0.0.0", "::", "spec.example", "8.8.8.8"])("--host %s → exit 2", async (host) => {
    // @spec SERV-020 integration
    expect(await runServe({ probe: false, port: "0", host, platformDir: clone })).toBe(2);
    expect(errs.join("\n")).toContain("--host");
  });

  test("the default bind is loopback with no token gate", () => {
    // @spec SERV-019 unit
    expect(resolveBind({})).toEqual({ host: "127.0.0.1", lan: null });
  });

  test("a private --host gets a random token, read-only unless --allow-writes", () => {
    // @spec SERV-023 unit
    const { lan } = resolveBind({ host: "192.168.0.10" });
    expect(lan?.token).toMatch(/^[0-9a-f]{64}$/);
    expect(lan?.allowWrites).toBe(false);
    expect(resolveBind({ host: "10.0.0.2", allowWrites: true }).lan?.allowWrites).toBe(true);
  });

  test("--token wins over SPEC_SERVE_TOKEN, which wins over a random token", () => {
    // @spec SERV-023 unit
    const prior = process.env.SPEC_SERVE_TOKEN;
    process.env.SPEC_SERVE_TOKEN = "env-token-0123456789";
    try {
      expect(resolveBind({ host: "10.0.0.2" }).lan?.token).toBe("env-token-0123456789");
      const pinned = resolveBind({ host: "10.0.0.2", token: "flag-token-0123456789" });
      expect(pinned.lan?.token).toBe("flag-token-0123456789");
    } finally {
      if (prior === undefined) delete process.env.SPEC_SERVE_TOKEN;
      else process.env.SPEC_SERVE_TOKEN = prior;
    }
  });

  test("a weak pinned token → exit 2", async () => {
    // @spec SERV-023 integration
    const code = await runServe({
      probe: false,
      host: "10.0.0.2",
      token: "short",
      platformDir: clone,
    });
    expect(code).toBe(2);
  });

  test("--probe ignores --host and stays on loopback", async () => {
    // @spec SERV-012 integration
    expect(await runServe({ probe: true, host: "192.168.0.10" })).toBe(0);
    expect(logs.join("\n")).toContain("serve --probe OK");
  });
});

describe("spec serve — pre-index guidance (RED-11)", () => {
  test("non-platform dir: friendly message + exit 2 (not 'failed to start'), no .spec-engine artifact", async () => {
    const bare = mkdtempSync(join(tmpdir(), "spec-serve-red11-"));
    try {
      const code = await runServe({ platformDir: bare, port: "0" });
      expect(code).toBe(2);
      expect(errs.some((m) => m.includes("is not a Spec Engine platform yet"))).toBe(true);
      // Directs the user toward their first completed spec.
      expect(errs.some((m) => m.includes("spec domain new"))).toBe(true);
      // The old path wrapped the error in a generic exit-1 message.
      expect(errs.some((m) => m.includes("failed to start"))).toBe(false);
      // Guard runs BEFORE mkdirSync/openStorage: nothing written.
      expect(existsSync(join(bare, ".spec-engine"))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ---------- RED-14 dead-end audit ----------

describe("spec serve — probe branch + bind-failure branch (RED-14)", () => {
  // @spec SERV-012 unit
  test("--probe binds loopback:0, self-fetches the placeholder, exits 0 (D-14)", async () => {
    // Until now the probe branch was only exercised by CI smoke 5 against
    // the compiled binary — never by `bun test`.
    const code = await runServe({ probe: true });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("serve --probe OK");
  });

  test("--probe FAILED when / answers non-200 → exit 1 (fetch stubbed)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    try {
      const code = await runServe({ probe: true });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("status was 500, expected 200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--probe FAILED when / answers 200 without the placeholder string → exit 1 (D-14)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("<html>wrong body</html>", { status: 200 })) as unknown as typeof fetch;
    try {
      const code = await runServe({ probe: true });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("did not contain the placeholder string");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("--probe FAILED when the self-fetch throws → exit 1 via the catch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("connection refused (stubbed)");
    }) as unknown as typeof fetch;
    try {
      const code = await runServe({ probe: true });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain("serve --probe FAILED:");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Bun.serve bind failure (port already taken) → storage closed, exit 1 'failed to start'", async () => {
    // Occupy a concrete loopback port so the real-serve branch's Bun.serve
    // throws EADDRINUSE inside the WR-01 try — the catch must close storage
    // and exit 1 (NOT the exit-2 crash convention: bind failure is an
    // environment problem, not a command crash).
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("blocker"),
    });
    try {
      const code = await runServe({
        platformDir: clone,
        port: String(blocker.port),
      });
      expect(code).toBe(1);
      expect(errs.join("\n")).toContain(`failed to start on 127.0.0.1:${blocker.port}`);
    } finally {
      blocker.stop(true);
    }
  });
});
