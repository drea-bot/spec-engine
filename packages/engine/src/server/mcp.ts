// packages/engine/src/server/mcp.ts
//
// The MCP front-end: the engine's operations as Model Context Protocol tools
// so an agent harness calls them natively instead of shelling out. Every tool
// call reindexes fresh, because the server is long-lived and the agent edits
// specs and tags between calls; at this scale a rebuild is milliseconds and a
// stale answer is a wrong answer. Results are the same JSON the CLI's --json
// modes emit. Domain errors are MCP tool errors, never crashes. stdout is the
// protocol channel; all chrome goes to stderr.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_QUERY_LIMIT, LIMIT_MAX } from "@spec-engine/shared";
import { z } from "zod";
import packageJson from "../../package.json" with { type: "json" };
import { domainScope, listDomainKeys, normalizeDomainKey } from "../authoring/domains";
import { coldFreshTags, withIndex } from "../operations/_index";
import { accept } from "../operations/accept";
import { check } from "../operations/check";
import { deprecate } from "../operations/deprecate";
import { nextId } from "../operations/nextId";
import { coverageReport, propagation, query, reqTags, resolveFiles } from "../operations/reads";
import {
  getRecord,
  type ListRecordsFilter,
  listRecords,
  requirementStatus,
  STATUS_WORDS,
} from "../operations/records";
import { supersede } from "../operations/supersede";
import { ID_RE } from "../parser/grammar";
import { renderAuthorPrompt } from "./authorPrompt";

/** Tool result helper: one JSON text block (the CLI --json shape). */
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

/** Tool error helper: an isError result, never a thrown crash. */
function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/**
 * Build the Spec Engine MCP server for one platform directory. Transport-free:
 * `spec mcp` connects it to stdio; tests connect it to an InMemoryTransport pair.
 */
export function buildMcpServer(platformDir: string): McpServer {
  const server = new McpServer({ name: "spec", version: packageJson.version });
  const fresh = <T>(fn: (storage: Parameters<typeof query>[0]) => T) =>
    withIndex({ platformDir, build: "fresh" }, (h) => fn(h.storage));

  server.registerTool(
    "spec_query",
    {
      title: "Full-text requirement retrieval",
      description:
        "Search requirements by full text (SQLite FTS5 MATCH syntax; wrap phrases in double quotes). Returns ranked hits — use this to load the requirements a task touches instead of re-asking the user.",
      inputSchema: {
        text: z.string().min(1).describe("FTS5 query text"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(LIMIT_MAX)
          .optional()
          .describe(`Max hits (default ${DEFAULT_QUERY_LIMIT})`),
      },
    },
    async ({ text, limit }) =>
      fresh((s) => {
        const r = query(s, text, limit ?? DEFAULT_QUERY_LIMIT);
        return r.ok ? jsonResult(r.hits) : errorResult(r.detail);
      }),
  );

  server.registerTool(
    "spec_resolve",
    {
      title: "Files → requirements",
      description:
        "The requirements tagged in the given files (platform-relative paths, e.g. api/src/renew.ts). Load these before changing the files.",
      inputSchema: {
        files: z.array(z.string().min(1)).min(1).max(100).describe("Platform-relative file paths"),
      },
    },
    async ({ files }) => fresh((s) => jsonResult(resolveFiles(s, files).rows)),
  );

  server.registerTool(
    "spec_req_tags",
    {
      title: "Requirement → tag sites (reverse query)",
      description:
        "Every code/test/doc site tagging the given requirement, across all repos — impact analysis and retag worklists.",
      inputSchema: { req_id: z.string().describe("Requirement id (KEY-NNN)") },
    },
    async ({ req_id }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      return fresh((s) => jsonResult(reqTags(s, req_id).rows));
    },
  );

  server.registerTool(
    "spec_coverage_report",
    {
      title: "Per-domain coverage rollup",
      description:
        "One row per domain over Active requirements: { domain, active, implemented, verified, orphans, unverified }.",
      inputSchema: {},
    },
    async () => fresh((s) => jsonResult(coverageReport(s).rows)),
  );

  server.registerTool(
    "spec_check",
    {
      title: "Integrity + coverage + drift diagnostics",
      description:
        "Run the full check: structural integrity, coverage, cross-repo drift. Returns the diagnostic rows (severity 'error' rows are what spec check --ci fails CI on).",
      inputSchema: {},
    },
    async () =>
      withIndex({ platformDir, build: "reset" }, async (h) => {
        const r = await check({ platformDir }, h.storage);
        return r.ok ? jsonResult(r.diagnostics) : errorResult(r.detail);
      }),
  );

  server.registerTool(
    "spec_propagation",
    {
      title: "Cross-repo propagation for a superseded requirement",
      description:
        "Per member repo: migrated to the successor (verified or not), still on the predecessor, or unrelated — plus the drift flag.",
      inputSchema: { req_id: z.string().describe("Requirement id (KEY-NNN)") },
    },
    async ({ req_id }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      return fresh((s) => jsonResult(propagation(s, req_id).rows));
    },
  );

  server.registerTool(
    "spec_next_id",
    {
      title: "Next unused requirement id",
      description:
        "Allocate-preview the next unused id in a domain (filesystem-derived; nothing is written). Use before authoring a new requirement.",
      inputSchema: { domain: z.string().min(1).describe("Domain key (e.g. BILLING)") },
    },
    async ({ domain }) => {
      const r = await nextId(platformDir, domain);
      return r.ok ? jsonResult({ domain: r.key, next_id: r.nextId }) : errorResult(r.detail);
    },
  );

  server.registerTool(
    "spec_get",
    {
      title: "One requirement's full record",
      description:
        "The full record for one requirement id: status, key, seq, statement, why, versions, and source location. An unknown id returns [] (the `spec get --json` shape).",
      inputSchema: { req_id: z.string().describe("Requirement id (KEY-NNN)") },
    },
    async ({ req_id }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      return fresh((s) => {
        const { row } = getRecord(s, req_id);
        return jsonResult(row ?? []);
      });
    },
  );

  server.registerTool(
    "spec_list",
    {
      title: "Every requirement record",
      description:
        "Every requirement record in (key, seq) order, superseded and deprecated history included. Optional domain and status filters. The `spec list --json` shape.",
      inputSchema: {
        domain: z.string().optional().describe("Only this domain key (e.g. BILLING)"),
        status: z
          .string()
          .optional()
          .describe(`Only this status: ${STATUS_WORDS.join(" | ")}`),
      },
    },
    async ({ domain, status }) => {
      const filter: ListRecordsFilter = {};
      if (domain !== undefined && domain.trim() !== "") filter.key = normalizeDomainKey(domain);
      if (status !== undefined) {
        const parsed = requirementStatus(status);
        if (parsed === null) {
          return errorResult(
            `status must be one of active|draft|superseded|deprecated; got ${status}`,
          );
        }
        filter.status = parsed;
      }
      return fresh((s) => jsonResult(listRecords(s, filter).rows));
    },
  );

  server.registerTool(
    "spec_supersede",
    {
      title: "Supersede a shipped requirement",
      description:
        "Flip an Active requirement to superseded, mint its successor in the same domain, and return the retag worklist (the tag sites spec check reports as SUPERSEDED_REFERENCED until retagged). The same JSON as `spec supersede --json`.",
      inputSchema: {
        req_id: z.string().describe("The Active requirement id to supersede (KEY-NNN)"),
        statement: z.string().min(1).describe("The successor's statement"),
        why: z
          .string()
          .optional()
          .describe("Successor's why (default: copied from the predecessor)"),
        lives_in: z
          .array(z.string())
          .optional()
          .describe("Successor's livesIn paths (default: copied from the predecessor)"),
        issue: z
          .string()
          .optional()
          .describe(
            "Ticket recorded as supersedes-via on the predecessor and created on the successor",
          ),
      },
    },
    async ({ req_id, statement, why, lives_in, issue }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      const r = await supersede(
        { platformDir, id: req_id, statement, why, livesIn: lives_in, issue },
        coldFreshTags(platformDir),
      );
      if (!r.ok) return errorResult(r.detail);
      for (const w of r.warnings) console.error(`spec_supersede: ${w.text}`);
      return jsonResult({
        old_id: r.oldId,
        new_id: r.newId,
        file: r.file,
        spec_version: r.specVersion,
        retag: r.retag,
      });
    },
  );

  server.registerTool(
    "spec_deprecate",
    {
      title: "Deprecate a requirement",
      description:
        "Mark an Active or Draft requirement deprecated with a recorded reason and return the code tags still bound to it (each a DEPRECATED_REFERENCED error in spec check until removed). The same JSON as `spec deprecate --json`.",
      inputSchema: {
        req_id: z.string().describe("The requirement id to deprecate (KEY-NNN)"),
        reason: z.string().min(1).describe("Why the requirement ended; the durable record"),
      },
    },
    async ({ req_id, reason }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      const trimmed = reason.trim();
      if (trimmed === "") return errorResult("reason must be non-empty");
      const r = await deprecate(
        { platformDir, id: req_id, reason: trimmed },
        coldFreshTags(platformDir),
      );
      return r.ok
        ? jsonResult({ id: r.id, file: r.file, reason: r.reason, sites: r.sites })
        : errorResult(r.detail);
    },
  );

  server.registerTool(
    "spec_accept",
    {
      title: "Accept a draft requirement",
      description:
        "Promote a Draft requirement to Active, leaving every other field untouched. The same JSON as `spec accept --json`.",
      inputSchema: {
        req_id: z.string().describe("The Draft requirement id to accept (KEY-NNN)"),
      },
    },
    async ({ req_id }) => {
      if (!ID_RE.test(req_id)) {
        return errorResult(`req_id must be a requirement id (KEY-NNN); got ${req_id}`);
      }
      const r = await accept({ platformDir, id: req_id });
      return r.ok ? jsonResult({ id: r.id, file: r.file }) : errorResult(r.detail);
    },
  );

  // A static playbook template: the engine runs no model; the client's does.
  // @spec AUTHOR-008
  server.registerPrompt(
    "author_requirements",
    {
      title: "Author requirements from a brief",
      description:
        "Turn a vague brief/ticket into well-formed Spec Engine requirements: one requirement per testable promise, placed by domain charter, deduped via spec query, drafted to the GUARD template + cold-read rubric, minted with spec req. The engine returns a static playbook template — your model runs it.",
      argsSchema: {
        brief: z.string().min(1).describe("The vague brief / ticket text to author from"),
        domain: z
          .string()
          .optional()
          .describe("Optional target domain KEY — its charter/scope is injected when given"),
      },
    },
    async ({ brief, domain }) => {
      // The domain is normalized and checked against the enumerated keys before
      // it is used to read a charter, so a traversal-laden value never escapes
      // platformDir; an unknown domain degrades to a null charter.
      let resolvedDomain: string | undefined;
      let charter: string | null = null;
      if (domain) {
        resolvedDomain = normalizeDomainKey(domain);
        if (listDomainKeys(platformDir).includes(resolvedDomain)) {
          charter = await domainScope(platformDir, resolvedDomain);
        }
      }
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: renderAuthorPrompt({ brief, domain: resolvedDomain, charter }),
            },
          },
        ],
      };
    },
  );

  return server;
}
