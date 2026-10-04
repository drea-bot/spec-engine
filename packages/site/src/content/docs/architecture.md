---
title: Architecture
description: What the engine is made of, which seams it has, and what must never change
---

Spec Engine is a derived-index pipeline. Truth lives in git as `spec-engine/<KEY>/SPEC.json` files plus `@spec` tags in code. Everything else is computed from those two inputs and can be thrown away.

```text
 CLI (citty)          HTTP (Hono)            MCP (stdio)
 engine/src/cli.ts    engine/src/server/     engine/src/server/mcp.ts
        │                   │                      │
        ▼                   ▼                      ▼
 ┌──────────────────────────────────────────────────────────┐
 │ Surfaces: parse input, call an operation, render         │
 │ engine/src/commands/*.ts  server/api.ts  server/mcp.ts   │
 └───────────────────────────┬──────────────────────────────┘
                             ▼
 ┌──────────────────────────────────────────────────────────┐
 │ Operations: one function per verb, typed input, typed    │
 │ result, no process exit, no console                      │
 │ engine/src/operations/*.ts                               │
 └───────────────┬──────────────────────────┬───────────────┘
                 │                          │
       write path│                 read path│
                 ▼                          ▼
 ┌────────────────────────┐   ┌──────────────────────────────┐
 │ authoring/  parser/    │   │ indexer/pipeline.ts runIndex │
 │ one seam:              │   │ discover → parse → scan →    │
 │ validateAndWrite       │   │ validate → one write tx      │
 │ (no bun:sqlite)        │   │ then check/ guard/ map/ …    │
 └───────────┬────────────┘   └──────────────┬───────────────┘
             ▼                               ▼
 ┌────────────────────────┐   ┌──────────────────────────────┐
 │ CANONICAL TRUTH (git)  │──▶│ DERIVED INDEX (disposable)   │
 │ spec-engine/*/SPEC.json│   │ .spec-engine/index.sqlite    │
 │ + @spec tags in code   │   │ via storage/sqlite.ts only   │
 └────────────────────────┘   └──────────────────────────────┘
```

## Components

| Component | Responsibility | Path |
| --- | --- | --- |
| CLI root | Register subcommands with lazy imports so the compiled binary starts fast | `packages/engine/src/cli.ts` |
| Command layer | One file per subcommand: flags, platform-dir resolution, exit codes, text or `--json` rendering | `packages/engine/src/commands/` |
| Operations | One function per verb. The CLI, the API, and MCP all call these | `packages/engine/src/operations/` |
| Discovery | Take membership and shape from platform-map, read each member's pin, derive the platform version. See [Platform Mapping](/platform-mapping/) | `packages/engine/src/indexer/discover.ts` |
| Parser | Read and validate `SPEC.json` envelopes into typed records | `packages/engine/src/parser/` |
| Scanner | Walk member repos, extract `@spec` tags, decide implements vs verifies from the path | `packages/engine/src/scanner/` |
| Index pipeline | `runIndex`: the one composition of discover, parse, scan, validate, write | `packages/engine/src/indexer/pipeline.ts` |
| Storage | The only `bun:sqlite` importer. Open, cold reset, upserts, queries, `build_id` | `packages/engine/src/storage/sqlite.ts` |
| Schema | Tables, the FTS5 table, and the `coverage`, `drift`, `term_drift`, `provenance_matrix` views | `packages/shared/src/schema.ts` |
| Storage contract | The `Storage` interface and row types every surface reads through | `packages/shared/src/storage.ts` |
| Checks | Diagnostic producers, SQL and non-SQL: grammar, file refs, removal, status flips, proofs, CODEOWNERS | `packages/engine/src/check/` |
| Loss guard | Diff the requirement derivation at a git ref against the worktree | `packages/engine/src/guard/` |
| Authoring | Domain scaffolds, next-id allocation, `@` file refs, statement grammar at write time | `packages/engine/src/authoring/` |
| Projections | One directory per computed answer, each with a `format.ts` for text mode | `map/`, `query/`, `resolve/`, `relations/`, `propagation/`, `provenance/`, `gate/`, `results/` |
| HTTP API | Hono routes over `Storage`, read routes always on, write routes flag-gated | `packages/engine/src/server/api.ts` |
| MCP server | Eleven tools and one prompt, same JSON as the CLI's `--json` | `packages/engine/src/server/mcp.ts` |
| Webapp | Server-rendered pages. No filesystem, no sqlite, no engine import | `packages/webapp/src/` |
| Tracker | Optional read-only Linear adapter with a cache sidecar | `packages/tracker/src/` |
| Docs site | This site, served offline by `spec docs` | `packages/site/` |

## Operations

An operation takes typed input and returns typed data or a typed refusal. It never exits the process and never prints. Each surface maps a refusal to its own vocabulary: the CLI to exit 2, the API to a status, MCP to an error result.

| Operation | Input | Result | CLI | HTTP | MCP |
| --- | --- | --- | --- | --- | --- |
| `query` | storage, text, limit | ranked hits, or `usage` on an FTS5 grammar error | `spec query` | `GET /api/query` | `spec_query` |
| `resolveFiles` | storage, platform-relative files | the requirements tagged in them | `spec resolve` | `GET /api/resolve?files=` | `spec_resolve` |
| `reqTags` | storage, requirement id | every tag site, and whether the id is known | `spec resolve --req` | `GET /api/resolve?req=` | `spec_req_tags` |
| `propagation` | storage, requirement id | per-member migration state | `spec propagation` | `GET /api/propagation/:id` | `spec_propagation` |
| `coverageReport` | storage | per-domain rollup | | `GET /api/report` | `spec_coverage_report` |
| `check` | storage, platform dir, results file, base ref, flags | diagnostics, `build_id`, red or green | `spec check` | | `spec_check` |
| `nextId` | platform dir, domain key or prefix | the resolved key and next unused id, or `usage` | `spec req` | | `spec_next_id` |
| `mint` | platform dir, key, statement, why, lives-in, issue, status | the new id and file, or `not_found` / `usage` / `invalid_domain_file` | `spec req --text` | `POST /api/requirements` | |
| `amend` | platform dir, id, fields, a fresh-tags callback | the changed fields, or `not_found` / `conflict` / `invalid_domain_file` | `spec amend` | `PUT /api/requirements/:id` | |
| `supersede` | platform dir, id, successor statement and fields, a fresh-tags callback | the successor id, the domain version, the retag worklist, or `not_found` / `conflict` / `usage` / `invalid_domain_file` | `spec supersede` | `POST /api/requirements/:id/supersede` | `spec_supersede` |
| `move` | platform dir, id, target domain key, optional successor fields, a fresh-tags callback | both files, both versions, the retag worklist, or `usage` / `not_found` / `conflict` / `invalid_domain_file` | `spec move` | | |
| `deprecate` | platform dir, id, reason, a fresh-tags callback | the file and the tags still bound, or `not_found` / `conflict` / `invalid_domain_file` | `spec deprecate` | `POST /api/requirements/:id/deprecate` | `spec_deprecate` |
| `accept` | platform dir, id | the file, or `not_found` / `conflict` / `invalid_domain_file` | `spec accept` | `POST /api/requirements/:id/accept` | `spec_accept` |
| `mintTerm`, `listTerms`, `reviseTerm`, `confirmTerm` | platform dir, term fields or ids | the term id, the store rows, the bumped version, or the re-pinned citation; `not_found` / `conflict` / `invalid_domain_file` | `spec term` | | |
| `coverageMatrix` | storage | requirement × repo rows | `spec map` | `GET /api/coverage` | |
| `getRecord` | storage, requirement id | one full `Requirement` row, or null | `spec get` | `GET /api/requirements/:id` | `spec_get` |
| `listRecords` | storage, optional key and status | every `Requirement` row in (key, seq) order | `spec list` | `GET /api/requirements` | `spec_list` |
| `relations` | storage | `relates` links | `spec relations` | `GET /api/relations` | |
| `provenance` | storage, optional issue id | provenance matrix rows | `spec provenance` | `GET /api/provenance` | |
| `guard` | storage, platform dir, git ref | the losses a change is about to cause | `spec guard` | | |
| `gate` | storage, platform dir, repo, requirement id | the gate outcome and `build_id`, or `usage` for an unknown repo | `spec gate` | | |
| `resolveMemberPin`, `writeMemberConfig` | repo dir, pin override, force | the pin and its source; wrote or already configured, or `usage` / `conflict` | `spec init` | | |
| `newDomain`, `listDomains` | platform dir, key | the scaffolded file, or `usage` / `conflict` / `invalid_domain_file`; the `{ key, scope }` rows | `spec domain` | | |
| `writeGlossary`, `migrateGlossary`, `checkGlossary` | platform dir | the generated count, the migrated count or a skip, clean or drift | `spec glossary` | | |

Reads take an open `Storage` handle because the surface owns the handle's lifetime: the CLI and MCP open one per call through `withIndex`, the API keeps one for the life of the server. Writes take the platform directory because they edit `SPEC.json` files. A lifecycle write takes a fresh-tags callback for its worklist, so a one-shot surface cold-rebuilds a throwaway index while the API re-indexes into the handle it keeps. Every guard runs before the first byte is written (REQ-038 <!-- @spec REQ-038 -->), and `operations-parity.test.ts` proves each surface writes the same envelope.

## The single seams

Each of these exists exactly once, and a grep fence in `scripts/arch-fences.sh` fails CI if a second copy appears. Every fence label starts with the id of the requirement the fence enforces, and the fence function carries that id as its `@spec` tag.

| Seam | What goes through it | Fence |
| --- | --- | --- |
| `runIndex` | Every index build. One transaction, one `build_id` | reviewed, not fenced |
| `validateAndWrite` | Every write of a `SPEC.json` file, a test's fixture included; a planted defect under `src/testing/fixtures/` is the only file written by hand | `SCHM-026 every SPEC.json write goes through validateAndWrite` |
| `bun:sqlite` import | Only `storage/sqlite.ts` may import it | `SCHM-025 bun:sqlite outside storage/sqlite.ts`, `SCHM-025 bun:sqlite outside the engine` |
| `Storage` interface | Every read the CLI, API, and MCP make | the webapp import fence in `packages/webapp/test/import-fence.test.ts` |
| Operations | The write seam and the id allocator are reached only through `operations/`; no command, route, or tool imports them. A test's fixture builder (`src/testing/platform.ts`) is one more caller of the same operations | `SCHM-027 write seam under operations` |
| No model calls | The engine never runs an LLM. The MCP authoring prompt is a text template | `AUTHOR-008 llm-free engine` |
| Derived versions | No authored `specVersion` on requirement domains | `SCHM-020 no authored specVersion` |
| Generated docs | `GLOSSARY.md` and the TAXONOMY charters are regenerated, never hand-edited | `CHCK-020 glossary round-trip`, `CHRT-007 charters generated from the envelopes` |

## Read path

`spec map`, `spec check`, `spec query`, and the other read commands:

1. Resolve `platformDir` and assert it contains `spec-engine/`. A non-platform directory exits 2 and leaves no `.spec-engine/` behind.
2. Open the index. `--fresh`, `check --ci`, and `gate` cold-reset it first.
3. If the index is missing, run `runIndex`. Otherwise trust it and warn on stderr when a `SPEC.json` is newer than the index.
4. Query the views.
5. Render text to stdout, or the sorted `--json` array. Warnings and guidance go to stderr.

## Write path

`spec req`, `spec amend`, `spec accept`, `spec supersede`, `spec move`, `spec deprecate`, `spec term`:

1. Resolve the target domain and run every guard before writing a byte.
2. Allocate the next id from the filesystem, never from the index.
3. Judge new statement text against the EARS grammar when the domain declares one.
4. Write the whole envelope through `validateAndWrite`.
5. Lifecycle commands then reindex fresh and print the retag worklist.

## HTTP path

1. `spec serve` composes the engine's API routes and the webapp's pages onto one Hono app, bound to `127.0.0.1` or one private `--host` address. A non-loopback bind wraps the app's fetch in a gate (token, Host pin, read-only) that the in-process page reads never pass through.
2. Pages call `/api/*` in-process. There is no loopback fetch.
3. A feature whose flag is off answers 404 on its endpoints and renders a placeholder page.

## Invariants

The six headline invariants (cold-rebuild identity, `check --ci` builds fresh, one shared schema, spec defects become diagnostics, one model one seam, drift is a view) are catalogued in `spec-engine/TAXONOMY.md` with the requirement id that records each.

## Anti-patterns

| Don't | Why | Do instead |
| --- | --- | --- |
| Write a value into the index that cannot be re-derived | A cold rebuild must give an identical result | Put truth in `SPEC.json` or a tag; express the report as a view |
| Import `bun:sqlite` in a second file | Forks the storage contract and reds the SCHM-025 fence | Extend `Storage` and implement it in `storage/sqlite.ts` |
| `Bun.write` a spec file directly | Skips schema validation | Mutate the envelope and call `validateAndWrite` |
| Use a ticket number as a requirement id or in a tag | Tickets are temporary; requirements outlive them | Mint with `spec req`, record the ticket with `--issue` |
| "Fix" a defect under `fixtures/` | Those defects are what `spec check` exists to catch | Leave them. Tags under `fixtures/` never index |
| Trust a warm index after editing specs or tags | Read commands only build when the index is missing | Pass `--fresh`, or use `check --ci` / `gate` |

## Error handling

- Exit codes are the contract: 0 success (including empty results), 1 data failure, 2 usage or environment error.
- Storage failures map to a named hint. A sandboxed process without file locks gets `SQLITE_IOERR_VNODE`; the CLI says so and `/api/*` returns a structured 503.
- Every guard runs before the first write, so a rejected `move` or `supersede` never half-applies.
- Outside git, `check` deletion detection and `spec guard` warn and exit 0.
