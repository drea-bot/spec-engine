// packages/engine/src/server/mcp.test.ts
//
// L4 (lifecycle pass) — the MCP front-end. buildMcpServer exposes the
// engine's read surface as MCP tools over the SAME storage seam the CLI
// and webapp use (one engine, three thin front-ends). Tested in-process
// via InMemoryTransport.createLinkedPair() + Client — no stdio spawn.
//
// Correctness contract: every tool call reindexes FRESH (rm + rebuild)
// before reading — an MCP server is long-lived and the agent on the other
// end edits specs and tags between calls; a warm index would serve stale
// truth. Locked by the "sees an edit made after the previous call" test.
//
// Tag lines composed via src/testing/specTag.ts (dogfood rule).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import packageJson from "../../package.json" with { type: "json" };
import { type DomainHandle, TestPlatform } from "../testing/platform";
import { specTag } from "../testing/specTag";
import { buildMcpServer } from "./mcp";

let fx: TestPlatform;
let platform: string;
let billing: DomainHandle;
let client: Client;
let cleanup: (() => Promise<void>) | null = null;

// A distinctive scope so the AUTHOR-003 charter-injection prompt test can
// assert the exact substring the prompt template injects for domain=BILLING.
const BILLING_SCOPE = "billing lifecycle: renewals, refunds, and invoice pricing";

// Two Active BILLING reqs → nextRequirementId reads SPEC.json and allocates
// BILLING-003.
beforeEach(async () => {
  fx = TestPlatform.temp("spec-mcp-");
  platform = fx.dir;
  billing = await fx.domain("BILLING", { scope: BILLING_SCOPE });
  await billing.req({
    statement: "renewal charges use the current plan price",
    why: "revenue",
    livesIn: ["renew.ts"],
  });
  await billing.req({ statement: "refunds reverse the original charge", why: "trust" });
  await fx.member("api", {
    files: {
      "src/renew.ts": `export const renew = 1; ${specTag("BILLING-001")}`,
      "test/renew.test.ts": `export const t = 1; ${specTag("BILLING-001", "unit")}`,
    },
  });

  const server = buildMcpServer(platform);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  fx.remove();
});

/** Call a tool and parse its single text content block as JSON. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(res.isError ?? false).toBe(false);
  expect(res.content[0]?.type).toBe("text");
  return JSON.parse(res.content[0]?.text ?? "null");
}

describe("spec mcp — tool surface (L4)", () => {
  test("reports the published package version as its server version", () => {
    expect(client.getServerVersion()?.version).toBe(packageJson.version);
  });

  test("lists the twelve tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "spec_accept",
      "spec_check",
      "spec_coverage_report",
      "spec_deprecate",
      "spec_get",
      "spec_list",
      "spec_next_id",
      "spec_propagation",
      "spec_query",
      "spec_req_tags",
      "spec_resolve",
      "spec_supersede",
    ]);
  });

  test("spec_query retrieves by full text", async () => {
    const rows = (await call("spec_query", { text: "renewal" })) as Array<{ req_id: string }>;
    expect(rows.map((r) => r.req_id)).toContain("BILLING-001");
  });

  test("spec_resolve maps files to requirements", async () => {
    const rows = (await call("spec_resolve", { files: ["api/src/renew.ts"] })) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual(["BILLING-001"]);
  });

  test("spec_req_tags is the reverse query", async () => {
    const rows = (await call("spec_req_tags", { req_id: "BILLING-001" })) as Array<{
      file: string;
    }>;
    expect(rows.map((r) => r.file)).toEqual(["api/src/renew.ts", "api/test/renew.test.ts"]);
  });

  test("spec_coverage_report returns the per-domain rollup", async () => {
    const rows = await call("spec_coverage_report");
    expect(rows).toEqual([
      { domain: "BILLING", active: 2, implemented: 1, verified: 1, orphans: 1, unverified: 0 },
    ]);
  });

  test("spec_check surfaces diagnostics (BILLING-002 is an orphan)", async () => {
    const rows = (await call("spec_check")) as Array<{ code: string; req_id: string | null }>;
    expect(rows.some((d) => d.code === "ORPHAN_REQ" && d.req_id === "BILLING-002")).toBe(true);
  });

  test("spec_next_id allocates from the filesystem", async () => {
    expect(await call("spec_next_id", { domain: "BILLING" })).toEqual({
      domain: "BILLING",
      next_id: "BILLING-003",
    });
  });

  test("spec_propagation classifies member repos for a superseded req", async () => {
    // Supersede BILLING-001 — then the api repo (still tagged BILLING-001)
    // classifies ON_PREDECESSOR.
    const { newId } = await billing.supersede("BILLING-001", {
      statement: "successor",
      why: "w",
      livesIn: [],
    });
    expect(newId).toBe("BILLING-003");
    // propagation takes the SUCCESSOR id: "who migrated to BILLING-003?"
    // api still tags BILLING-001 (the predecessor) → ON_PREDECESSOR.
    const rows = (await call("spec_propagation", { req_id: "BILLING-003" })) as Array<{
      repo: string;
      state: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repo).toBe("api");
    expect(rows[0]?.state).toBe("ON_PREDECESSOR");
  });

  test("every call reindexes fresh: an edit made after the previous call is visible", async () => {
    await call("spec_query", { text: "renewal" }); // builds the index
    await billing.req({ statement: "invoices itemize tax separately", why: "w" });
    const rows = (await call("spec_query", { text: "itemize" })) as Array<{ req_id: string }>;
    expect(rows.map((r) => r.req_id)).toContain("BILLING-003");
  });

  test("malformed req_id returns an MCP tool error, not a crash", async () => {
    const res = (await client.callTool({
      name: "spec_req_tags",
      arguments: { req_id: "not-an-id" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("KEY-NNN");
  });

  test("unknown domain in spec_next_id returns a tool error listing candidates", async () => {
    const res = (await client.callTool({
      name: "spec_next_id",
      arguments: { domain: "ZZZ" },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("BILLING");
  });
});

// ── Wave 0 RED bar: the author_requirements MCP prompt (AUTHOR-003) ──────────
// These are the VERIFYING tests for AUTHOR-003, minted in Wave 2 (its verifying
// `@spec` tags — AUTHOR-003 unit — are added atomically at that mint; none is
// written here, a tag before its mint is a DANGLING_TAG that fails
// `spec check . --ci`). Authored RED-first: no `author_requirements` prompt is
// registered on the McpServer yet, so `prompts/list` omits it and `prompts/get`
// rejects it — each assertion fails as a clean protocol/content failure. Wave 2
// registers the prompt (a static template, engine stays LLM-free) and greens
// them. Prompts are NOT tools — the "lists the twelve tools" assertion above
// is deliberately left untouched.
// @spec AUTHOR-008 unit
// @spec AUTHOR-009 unit
describe("spec mcp — author_requirements prompt (AUTHOR-003)", () => {
  /** Read the single text message body of a prompts/get result. */
  function promptText(res: { messages: Array<{ content: unknown }> }): string {
    return (res.messages[0]?.content as { type: "text"; text: string }).text;
  }

  test("prompts/list advertises author_requirements with brief + domain args", async () => {
    const { prompts } = await client.listPrompts();
    const p = prompts.find((x) => x.name === "author_requirements");
    expect(p).toBeDefined();
    expect(p?.arguments?.map((a) => a.name).sort()).toEqual(["brief", "domain"]);
  });

  test("prompts/get substitutes the brief and takes the no-domain branch", async () => {
    const res = await client.getPrompt({
      name: "author_requirements",
      arguments: { brief: "let users export invoices as PDF" },
    });
    const text = promptText(res);
    // The brief is echoed verbatim inside the static template.
    expect(text).toContain("let users export invoices as PDF");
    // A stable playbook-body token.
    expect(text).toContain("One requirement per behavior");
    // The no-domain branch marker (no target domain given).
    expect(text).toContain("determine placement from `spec domain list`");
  });

  test("prompts/get injects the domain charter/scope when a domain is given", async () => {
    const res = await client.getPrompt({
      name: "author_requirements",
      arguments: { brief: "add annual billing", domain: "BILLING" },
    });
    const text = promptText(res);
    expect(text).toContain("Target domain: BILLING");
    // The BILLING envelope's scope, injected verbatim from domainScope (FS read).
    expect(text).toContain(BILLING_SCOPE);
  });

  test("prompts/get path-containment: a traversal-laden domain injects no charter", async () => {
    // CR-01: a `../`-laden domain arg must never escape platformDir into an
    // arbitrary SPEC.json — the callback normalizes THEN membership-checks
    // before any domainScope read, so an out-of-tree domain degrades to a
    // null charter (the "check placement" branch), never a reflected file.
    const res = await client.getPrompt({
      name: "author_requirements",
      arguments: { brief: "add annual billing", domain: "../../../etc/passwd" },
    });
    const text = promptText(res);
    expect(text).not.toContain(BILLING_SCOPE);
    expect(text).not.toContain("Domain charter (scope):");
    expect(text).toContain("no charter/scope recorded");
  });
});
