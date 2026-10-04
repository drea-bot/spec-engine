---
title: Commands
description: Complete CLI command reference
---

Install the CLI from npm — `bun add -g @spec-engine/spec-engine` puts `spec` on your PATH, and every command below is written that way. Without a global install, run any of them as `bunx @spec-engine/spec-engine <command> [args]`; from a checkout, as `bun packages/engine/src/cli.ts <command> [args]`. See [Getting Started](/getting-started/) for the details.

## Exit code contract

| Code | Meaning |
| --- | --- |
| 0 | Success. Empty results are success (`[]` on stdout, guidance on stderr). |
| 1 | Data-level failure: `check` found ≥1 error-severity diagnostic; `guard` found a loss; `gate` failed; `index` crashed mid-build. |
| 2 | Usage/environment error: bad args, not a Spec Engine platform, path-containment violation, etc. |

## Common flags

Index-touching commands (`index`, `check`, `map`, `query`, `relations`, `resolve`, `propagation`, `provenance`, `gate`, `serve`) accept:

- `--out <path>` — DB path override (must resolve inside `platformDir`)
- `--no-prompt` — suppress interactive onboarding prompt
- `--json` — emit structured output (all except `serve`)

Read commands (`map`, `query`, `relations`, `resolve`, `propagation`, `provenance`) trust a schema-matching existing index; pass `--fresh` to force a cold rebuild first. `check --ci` and `gate` always rebuild cold — correctness never trusts a warm index.

## Command reference

### `spec index [platformDir]`

Build or refresh the derived SQLite index at `<platformDir>/.spec-engine/index.sqlite`. `--json` emits `{ build_id, repos, domains, requirements, tags, diagnostics }`; `build_id` is deterministic for identical inputs.

**Exit codes:** 0 / 1 / 2

### `spec check [platformDir]`

Cross-repo integrity, coverage, and drift diagnostics. See [Integrity Checks](/checks/) for every code.

| Flag | Description |
| --- | --- |
| `--ci` | Force cold rebuild (delete DB first) |
| `--results <junit.xml>` | Trusted-red proof gate: a verifying tag only counts when its test *passed* — fires `UNPROVEN_REQ` otherwise. Without it, `PROOFS_UNCONFIRMED` reminds you the gate is presence-only |
| `--base <ref>` | Governance diff against a git ref: fires `REQUIREMENT_REMOVED` / `UNAPPROVED_STATUS_FLIP` (and `PARTIAL_PROPAGATION` with `--results`) |
| `--approved-by <list>` | Approver set consulted by the status-flip governance check |
| `--require-owner-approval` | Escalate `UNAPPROVED_STATUS_FLIP` from warning to error |
| `--unsourced-change` | Opt-in: warn on superseded requirements lacking a `supersedes-via` issue |

**Exit codes:** 0 (clean) / 1 (errors found) / 2 (crash)

### `spec guard [platformDir]`

The pre-commit **loss gate**: diffs the requirement derivation at `--against <ref>` (default `HEAD`) against the working tree and blocks a change about to lose a requirement, its last implementation, or its last test. Losses: `REQUIREMENT_REMOVED` (an active requirement gone with no supersession), `IMPL_LOST` / `VERIFY_LOST` (a surviving requirement's last implementing/verifying tag removed), `SPEC_FILE_DELETED`. A loss is suppressed only by superseding or deprecating the requirement in the same change — there is no override comment. A non-git tree or unknown ref warns and exits 0 — the guard is a safety net, not a git dependency.

| Flag | Description |
| --- | --- |
| `--against <ref>` | Git ref to diff against (default `HEAD`) |
| `--json` | Emit `{ kind, req_id, file, line, detail }` rows, byte-stable |

**Exit codes:** 0 (clean) / 1 (loss found) / 2

### `spec map [platformDir]`

Render the cross-repo coverage matrix. **Exit codes:** 0 / 2

### `spec get <KEY-NNN> [platformDir]`

Print one requirement's full record (status, key, seq, statement, why, versions, source location). `--json` prints the same object `GET /api/requirements/:id` serves. An unknown id prints `[]` with guidance on stderr and exits 0. **Exit codes:** 0 / 2

### `spec list [platformDir] [--domain KEY] [--status S]`

Print every requirement record in (key, seq) order, superseded and deprecated history included. `--domain` narrows to one key; `--status` to `active`, `draft`, `superseded`, or `deprecated` (any other word exits 2). **Exit codes:** 0 / 2

### `spec query <text> [platformDir]`

Full-text retrieval over requirements (FTS5, BM25-ranked, best first). Superseded requirements are excluded. Glossary term definitions ride the same index and surface in a separate Terms group. `--limit N` (default 10, max 1000). Wrap multi-word phrases in quotes; bare `AND`/`OR` is an FTS5 grammar error (exit 2).

**Exit codes:** 0 / 2

### `spec relations [platformDir]`

Render `relates` links as a mermaid `graph LR` diagram (text mode) or `{ from_id, to_id, source_file, line }` rows (`--json`). **Exit codes:** 0 / 2

### `spec provenance [issueId] [platformDir]`

Per-requirement provenance matrix: the issues that created/revised/retired it (by role), the backing tests, and a git pointer. An optional leading `<issueId>` is a display-only reverse-lookup filter — the issue ID stays opaque, never a join key. `--resolve-issues` overlays tracker title/status/URL via the optional adapter (needs `SPEC_TRACKER_TOKEN`; off by default, degrades gracefully).

**Exit codes:** 0 / 2

### `spec resolve <files...> [platformDir]`

Requirements tagged in the given files. Accepts multiple positionals, comma-split within a positional, and absolute paths under the platform tree. `--req KEY-NNN` inverts the lookup: every tag site for that requirement across all repos.

**Exit codes:** 0 / 2

### `spec propagation <reqId> [platformDir]`

Classify each member repo's relationship to a superseded requirement: `MIGRATED_VERIFIED`, `MIGRATED_UNVERIFIED`, `ON_PREDECESSOR`, `ON_OTHER_DOMAIN_REQ`, `NO_DOMAIN_REFERENCE` — plus a `drifted` flag per member. Rows are in dependency order, providers before consumers, read from platform-map's `dependsOn`; ties by name. See [Platform Mapping](/platform-mapping/).

**Exit codes:** 0 / 2

### `spec gate <repo> <reqId> [platformDir]`

Approval primitive. Passes iff `<reqId>` is Active AND `<repo>`'s pin covers the requirement's `changed_at_version`. **Decision order:** `NOT_FOUND` → `DRAFT` → `SUPERSEDED` → `VERSION_PIN` → `PASS`; pin equality passes. An unknown repo is a usage error (exit 2), not a gate failure.

**Exit codes:** 0 (PASS) / 1 (failure) / 2 (bad args)

### `spec init [repo]`

Declare a member and write its `spec-engine.member.json`. A repository directly under the platform folder that the platform file does not list is declared through platform-map first (a platform file entry and a marker), then pinned; a workspace package of a monorepo gets a nested pin and no declaration; a plain folder platform-map cannot declare is refused. Pin resolution: `--specs <pin>` wins; else the **derived platform version** (the max of the enclosing platform's domain versions); else `spec-engine@1` with a printed note. An existing config is left untouched ("already configured", exit 0); `--force` rewrites the pin while preserving an `ignore` list. `--platform <dir>` records a declared member's checkout that lives outside the platform folder in platform-map's per-user file. See [Platform Mapping](/platform-mapping/).

**Exit codes:** 0 / 2 (never exit 1)

### `spec domain new <name>` / `spec domain list [platformDir]`

Scaffold `spec-engine/<KEY>/SPEC.json` (input normalized to uppercase, whitespace stripped) / list domains with their charters (`--json`: sorted `{ key, scope }` array, read from the filesystem).

**Exit codes:** 0 / 2

### `spec migrate [platformDir]`

One-time hard cutover: convert every legacy canonical `SPEC.md` to a schema-validated sibling `SPEC.json`, then delete the `SPEC.md`. Idempotent — skips already-migrated dirs.

**Exit codes:** 0 / 2

### `spec req <domain-prefix> [platformDir]`

**Piped:** prints the next unused requirement ID (e.g. `BILLING-010`) — zero prompts, zero writes. **TTY:** interactive authoring. **`--text` (+ `--why` / `--lives`):** appends a born-active entry non-interactively through the validated write seam. **`--draft`:** the entry is born Draft instead (promote it with `spec accept`). Prefix is case-insensitive (`bil` → `BILLING`; ambiguous → exit 2). `spec req <domain>` alone prints the domain's charter before authoring.

**Exit codes:** 0 / 2

### `spec term …`

The glossary authoring surface — a term is a requirement row in the reserved `TERM` domain (definition in the statement, headword in `term`, synonyms in `aliases`):

- `spec term "<name>" --def "<definition>" [--aliases a,b] [--section s]` — author a `TERM-NNN`
- `spec term list` — every term's `id name status`, read from the filesystem
- `spec term revise <TERM-NNN> --def "…"` — rewrite a definition **in place** (same id) and bump the TERM envelope's authored `specVersion`, the pin citations drift against
- `spec term confirm <KEY-NNN> <TERM-NNN>` — re-pin a requirement's citation to the term's current version (clears `TERM_DRIFT`); re-points to the successor when the cited term was superseded (clears `SUPERSEDED_TERM_REFERENCED`)

`spec supersede` and `spec amend` work on TERM ids exactly as on requirements.

**Exit codes:** 0 / 2

### `spec glossary [platformDir]`

The GLOSSARY.md round-trip. Default: **generate** GLOSSARY.md from the TERM store, byte-stable and LLM-free. `--migrate`: one-time parse of an existing GLOSSARY.md into `TERM-001..N` (idempotent-skip). `--check`: regenerate into a buffer and fail (exit 1) if the committed file drifts — a CI fence.

**Exit codes:** 0 / 1 / 2

### `spec supersede <reqId> [platformDir]`

The post-ship lifecycle move, mechanized. Flips the entry to superseded, mints the successor (`--text` required non-TTY; `--why`/`--lives` default to copies), reindexes, and prints the **retag worklist** — every code site still on the old ID. The target must be Active.

On a requirement domain the reported `spec_version` is the **derived** domain version after the supersession — no authored counter is written, and `--no-bump` is a no-op (there is no counter to hold back). On the reserved TERM domain the authored `specVersion` still bumps (it is the term-drift pin) and `--no-bump` opts out.

`--json`: `{ old_id, new_id, file, spec_version, retag: [...] }`

**Exit codes:** 0 / 2

### `spec move <reqId> <NEW-DOMAIN> [platformDir]`

Cross-domain supersede for taxonomy reorganization: mints the successor as the next id in `<NEW-DOMAIN>` (which must exist), carrying the source's fields (`--text`/`--why`/`--lives` override), flips the source to superseded with a cross-domain `supersededBy`, and emits the retag worklist. Both envelopes validate before either is written — a reject never half-applies. Only Active requirements move; moving into the source's own domain is a usage error (use `supersede`).

**Exit codes:** 0 / 2

### `spec amend <reqId> [platformDir]`

Revise an unshipped requirement's fields in place — same ID, no version change (the domain version only derives from supersessions). Field flags name what changes (`--text`/`--why`/`--lives`, at least one); untouched fields stay byte-identical. `--lives` repeats or comma-separates and replaces the whole list; `--lives ""` clears it. Only Active and Draft entries amend.

**Exit codes:** 0 / 2

### `spec accept <reqId> [platformDir]`

Promote a Draft requirement to Active — same ID, every other field untouched, no version change. A Draft is never an orphan, never unverified, and never counted in coverage; accepting it makes it an obligation.

**Exit codes:** 0 / 2

### `spec serve [platformDir] [--port N] [--host IP] [--token T] [--allow-writes]`

Launch the local webapp over the derived index on `127.0.0.1`, or on a private `--host` address that requires the printed token and is read-only unless `--allow-writes`. `--probe` smoke-tests and exits.

**API routes (always on):** `/api/coverage`, `/api/report` (per-domain rollup over Active reqs), `/api/repos`, `/api/platform` (the derived platform version), `/api/requirements[/:id]`, `/api/propagation/:id`, `/api/resolve?files=...`

**Feature-flagged routes:** `/api/query?q=&limit=`, `/api/relations[?format=mermaid]`, `/api/provenance`, and the editor's write routes answer **404** until their feature is enabled — the unshipped webapp features (query, relations, provenance, editor, glossary, logs) all default off. Opt in locally with a comma-separated `SPEC_FLAGS` env var: `SPEC_FLAGS=query,relations spec serve .` (unknown keys are ignored).

**Exit codes:** 0 / 1 / 2

### `spec mcp [platformDir]`

Serve Spec Engine as a Model Context Protocol server over stdio. Tools: `spec_query`, `spec_resolve`, `spec_req_tags`, `spec_coverage_report`, `spec_check`, `spec_propagation`, `spec_next_id`, `spec_get`, `spec_list`, `spec_supersede`, `spec_deprecate`, `spec_accept` — the same JSON the CLI's `--json` modes emit, reindexed fresh per call. Also advertises the `author_requirements` prompt (a static authoring playbook; the engine itself runs no model).

**Exit codes:** 0 / 2
