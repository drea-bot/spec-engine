# Spec Engine — agent reference

Machine-oriented reference for coding agents driving the `spec` CLI. Exact
contracts, exit codes, `--json` shapes, copy-paste commands.

- Narrative and rationale: [README](README.md).
- Process, setup, PR flow: [CONTRIBUTING.md](CONTRIBUTING.md).
- Terminology: [GLOSSARY.md](GLOSSARY.md). A *domain* is the concept, a *spec*
  is the `SPEC.json` artifact recording it, a *requirement* is the durable
  `KEY-NNN` unit.
- Components, seams, invariants: the
  [architecture page](packages/site/src/content/docs/architecture.md).

A CI test (`packages/engine/src/cli.docs-agents.test.ts`) fails if any public
subcommand in `packages/engine/src/cli.ts` is missing from this file.

## Working in this repo

This repo dogfoods its own `@spec` protocol: requirements live in
`spec-engine/<DOMAIN>/SPEC.json`, code binds to them with `@spec` tags.

Gates to keep green before a PR:

```bash
bun test                                      # full suite
bunx biome check .                            # lint + format
bun run typecheck
bun packages/engine/src/cli.ts check . --ci   # the self-gate
bash scripts/arch-fences.sh                   # the grep fences
```

Rules:

- **The derived index owns nothing.** Never encode truth in `.spec-engine/`. It
  is rebuilt from `spec-engine/` plus `@spec` tags and must rebuild identically.
- **Coverage is a SQL view**, never a materialized table.
- **One engine, not two.** An operation is written once under
  `packages/engine/src/operations/`. A surface (a command file, an API route,
  an MCP tool) may only parse its input, call the operation, and render the
  result. No forked logic between surfaces.
- **Keep the planted defects in `fixtures/`.** They exist so `spec check` has
  something to catch.
- **Exactly one `bun:sqlite` import**, in `packages/engine/src/storage/sqlite.ts`.
  Enforced by `fence_d08_engine_internal` in `scripts/arch-fences.sh` (SCHM-025).
- **Every `SPEC.json` read parses through the shared schema.** `parseDomainText`
  in `packages/shared/src/domain.ts` is the one place bytes become a domain
  envelope, and every operation, check, and reader consumes the `SpecDomain`
  it returns. `JSON.parse` otherwise appears only in the readers that own
  their own schema (the member config, the root `package.json`, the HTTP
  body), and nothing in production source casts through `unknown`. Enforced
  by `fence_schm030_schema_reads` (SCHM-030).
- **A test authors its platform through the operations.** `TestPlatform` in
  `packages/engine/src/testing/platform.ts` scaffolds domains, mints,
  supersedes, deprecates, moves, mints terms, and writes member configs by
  calling `operations/`, so a fixture is what a `spec` command would have
  written. A state the engine refuses to author (a removed entry, an
  unapproved status flip, a forward `supersedes` pointer, a grammar declared
  after the fact) is planted with `plantEdit` in `src/testing/plant.ts`, which
  still writes through `validateAndWrite`. A schema-invalid file lives under
  `src/testing/fixtures/`. Nothing else writes a `SPEC.json` by hand: the
  SCHM-026 fence scans every source file and every test.
- **Membership is platform-map's; the pin is ours.** Which directories are
  members, and whether a repo is a monorepo, comes from
  `@spec-engine/platform-map` (`map()` and `locate()`, imported only in
  `packages/engine/src/indexer/discover.ts`). This checkout is a lone
  monorepo with no platform file: its coverage columns are the root
  `workspaces` packages (`packages/*` and `scripts`), each pinned to the
  derived platform version unless it carries a nested
  `spec-engine.member.json` (`scripts/` does). A fixture platform
  (`fixtures/platform-fixture`, the trees under `src/testing/fixtures/`)
  carries a `platform-map.json` platform file, a marker and a private
  `package.json` per member. See the
  [platform-mapping page](packages/site/src/content/docs/platform-mapping.md).
- **A member config, a platform file, and a marker are authored with
  `spec init`, never by hand.** This checkout is the engine's own platform
  (the root `package.json` is `@spec-engine/spec-engine`), so `spec init`
  judges the spec-engine/ path-segment refusal below the platform root and
  `spec init scripts` works here (INIT-030). Rewrite a pin with
  `spec init <dir> --force`. A fixture platform under `fixtures/` is
  declared by running `spec init` on a temporary copy of the tree and
  copying the two `platform-map.json` files back: the checkout's own path
  carries a `spec-engine` segment, and only the engine platform is judged
  below its root.
- **Every fence is a requirement.** Each `fence_*` function in
  `scripts/arch-fences.sh` carries the `@spec` tag of the requirement it
  enforces, and its `run` label starts with that id. `scripts/` is a
  workspace package (`scripts/package.json`) with its own pin
  (`scripts/spec-engine.member.json`) so those tags index; the scanner reads
  `.sh` files as code.
- **The planted-fixture diagnostic baseline is one file**,
  `fixtures/platform-fixture.diagnostics.json`, read by
  `packages/engine/src/commands/check.ci.test.ts` and by smokes 7, 18, and
  23. A change to the planted set moves that file only.
- **The CI smokes are scripts.** `bash scripts/smoke.sh` runs every
  `scripts/smoke/NN-*.sh` in order against `./dist/spec` (`bun run build:cli`
  first); `bash scripts/smoke.sh 7` runs one. `.github/workflows/ci.yml`
  calls the same scripts, and `shellcheck` over `scripts/` is a lint step, so
  a red smoke reproduces locally before it costs a CI cycle.
- **A test lives beside the file it tests.** `foo.ts` is tested by `foo.test.ts`
  in the same directory; a second test file for the same source is
  `foo.<aspect>.test.ts` (`check.ci.test.ts`, `sqlite.fts.test.ts`). Shared
  helpers and planted trees live in `packages/<pkg>/src/testing/`. Only a test
  of a package- or repo-wide invariant with no single file under test
  (`architecture-fences`, `corpus-hygiene`, `taxonomy`, `npm-package`, the
  webapp import fence) lives in `packages/<pkg>/test/`. The tag scanner
  classifies a file as a test by the `.test.` substring, so a co-located tag
  still verifies; the engine-internal fences and the marker ratchet skip
  `*.test.ts` and `src/testing/`, the write-seam fence does not.
- **A fence runs inside `bun test` under a 5-second budget**
  (`architecture-fences.test.ts` spawns the whole script). Keep each fence to
  one process.

Comments:

- A comment carries a mechanical constraint the code cannot state. Nothing else.
- Before writing one, prefer a named function, a test, or an `@spec KEY-NNN` tag.
- Never restate a requirement, name a plan, phase, wave, pitfall, or review
  round, or narrate how the code got here. Behavior lives in `SPEC.json`.
- Enforced by `fence_comment_markers`, a ratchet over
  `scripts/comment-marker-debt.txt`: a file absent from the ledger must carry
  zero markers, and a listed file's count may only fall.

## Invocation

```
bun packages/engine/src/cli.ts <command> [...]   # from a checkout (this repo's default)
./dist/spec <command> [...]                     # compiled binary (bun run build:cli)
bunx @spec-engine/spec-engine <command> [...]   # published npm package (requires Bun)
```

- Almost every command takes an optional trailing `platformDir` positional
  (default: cwd). The platform dir is the directory that contains `spec-engine/`.
- Every command is non-interactive when stdin is not a TTY.
- `--json` goes to **stdout only**. Guidance, warnings, and diagnostics chrome go
  to **stderr**. Parse stdout, surface stderr.

## The mechanics

The eight statements the engine implements are in the README under "The idea".
How this implementation realizes them:

1. Canonical truth: `spec-engine/<DOMAIN>/SPEC.json`, one envelope
   `{ key, owner, updated, scope, requirements[] }` per domain, validated by the
   one `@spec-engine/shared` schema on every read and write. Ids (`KEY-NNN`)
   are permanent. Changes supersede or `spec deprecate`, never overwrite.
2. Code binds with a tag: `// @spec KEY-NNN`. A test tag may add a level token
   `unit` | `integration` | `e2e`. The scanner reads `.ts`, `.tsx`, `.js`,
   `.jsx`, `.mjs`, `.sh`, `.lua`, `.luau`, `.go`, and `.rs` files; the tag
   regex ignores the comment leader, so `--`, `//`, and `#` all work.
3. Tag kind is path-derived. A tag in implementation code **implements**; a tag
   in a test path **verifies**. Never write those words in the tag. A test
   path contains `.test.`, `.spec.`, `__tests__/`, `/tests/`, `/e2e/`, or
   `.e2e.`, or ends in `_test.go`, `_test.rs`, `_spec.lua`, or `_test.lua`,
   or lives under `spec/` (busted). Rust tests inline under `#[cfg(test)]`
   sit in the implementation file and count as implements; put a verifying
   tag in `tests/` or a `*_test.rs` file.
4. The index at `<platformDir>/.spec-engine/index.sqlite` is derived and
   disposable. Read commands build it when missing. Deleting it is always safe.
5. Coverage, drift, and propagation are SQL projections over tags. Drift
   compares a member's pin (`spec-engine@N`, one platform-wide scalar) against
   each referenced requirement's `changed_at_version`, derived within its
   domain's supersede graph. The platform version is the max domain version.
   A stray `spec-engine.platform.json` is ignored with a warning.
6. **Requirements are not issues.** One ticket splits into several
   requirements. Never use a ticket number as a requirement id or in a tag.
   Ticket links (`--issue`, the `issues` field) are provenance only.
7. Membership and shape are `@spec-engine/platform-map`'s: a platform is
   the directory holding `spec-engine/` and, when declared, the platform
   file `platform-map.json` `{ name, members, ignore }`; a member is a name
   in that file with a `{ platform, member }` marker; a monorepo's coverage
   columns are its workspace packages, named by path (`packages/engine`);
   a lone repo with no platform file is one column or its packages; a monorepo's files outside every package are one more column, named by the member or, for a lone monorepo, the directory. The
   pin is the one fact `spec-engine.member.json` adds. `spec init <name>`
   declares and pins in one step; no `spec` workflow runs a platform-map
   command. platform-map's `dependsOn` orders `spec propagation`: providers
   before consumers. Full model: the [Platform Mapping
   page](packages/site/src/content/docs/platform-mapping.md).

## Exit code contract

| Code | Meaning |
| --- | --- |
| 0 | Success. Empty results are success (`[]` on stdout, guidance on stderr). |
| 1 | Data-level failure: `check` found an error-severity diagnostic; `guard` found a loss; `gate` failed; `index` crashed mid-build. |
| 2 | Usage/environment error: bad args, not a Spec Engine platform (no `spec-engine/`), path-containment violation, invalid `--limit`/`--port`, FTS5 syntax error. |

Branch on exit codes, not on output text.

## Commands

| Command | Synopsis | `--json` | Exits |
| --- | --- | --- | --- |
| `spec index [platformDir]` | Build or refresh the derived index | yes (IndexResult) | 0 / 1 / 2 |
| `spec check [platformDir] [--ci]` | Integrity + coverage + drift diagnostics | yes (array) | 0 / 1 / 2 |
| `spec guard [platformDir] [--against <ref>]` | Block a change about to lose a requirement, its last implementation, or its last test | yes (array) | 0 / 1 / 2 |
| `spec map [platformDir]` | Requirement × repo coverage matrix | yes (array) | 0 / 2 |
| `spec get <KEY-NNN> [platformDir]` | One requirement's full record; unknown id is `[]` | yes (object, or `[]`) | 0 / 2 |
| `spec list [platformDir] [--domain KEY] [--status S]` | Every requirement record in (key, seq) order, history included | yes (array) | 0 / 2 |
| `spec query <text> [platformDir]` | Full-text retrieval over requirements | yes (array) | 0 / 2 |
| `spec relations [platformDir]` | Mermaid graph of `relates` links | yes (array) | 0 / 2 |
| `spec provenance [issueId] [platformDir]` | Per-requirement provenance matrix | yes (array) | 0 / 2 |
| `spec resolve <files…> [platformDir]` | Requirements tagged in the given files | yes (array) | 0 / 2 |
| `spec propagation <KEY-NNN> [platformDir]` | Per-repo migrated/drifted state for a superseded requirement | yes (array) | 0 / 2 |
| `spec gate <repo> <KEY-NNN> [platformDir]` | Approval gate: pass iff Active and the pin covers it | yes (object) | 0 / 1 / 2 |
| `spec init [repo]` | Declare a member through platform-map and write its `spec-engine.member.json` pin | yes (object) | 0 / 2 |
| `spec domain new <KEY>` / `spec domain list` | Scaffold / list `spec-engine/<KEY>/SPEC.json` | `list`: yes (array) | 0 / 2 |
| `spec migrate [platformDir]` | One-time cutover of every `SPEC.md` to `SPEC.json` (idempotent) | no | 0 / 2 |
| `spec req <domain-prefix> [platformDir]` | Piped: next unused id. `--text`: author non-interactively | yes (object) | 0 / 2 |
| `spec term …` | Author, list, revise, and confirm glossary terms | yes | 0 / 2 |
| `spec glossary [platformDir]` | Generate `GLOSSARY.md` from the TERM store; `--migrate`, `--check` | yes (object) | 0 / 1 / 2 |
| `spec deprecate <KEY-NNN> --reason "…" [platformDir]` | End an Active/Draft requirement with a recorded reason | yes (object) | 0 / 2 |
| `spec supersede <KEY-NNN> [platformDir]` | Flip to superseded, mint the successor, emit the retag worklist | yes (object) | 0 / 2 |
| `spec move <KEY-NNN> <NEW-DOMAIN> [platformDir]` | Cross-domain supersede | yes (object) | 0 / 2 |
| `spec amend <KEY-NNN> [platformDir]` | Revise an unshipped entry in place | yes (object) | 0 / 2 |
| `spec accept <KEY-NNN> [platformDir]` | Promote a Draft requirement to Active | yes (object) | 0 / 2 |
| `spec serve [platformDir] [--port N] [--host IP]` | Local webapp + `/api/*` over the index | n/a (HTTP) | 0 / 1 / 2 |
| `spec docs [--port N]` | Serve the bundled docs site offline | n/a (HTTP) | 0 / 1 / 2 |
| `spec mcp [platformDir]` | MCP server over stdio | n/a (JSON-RPC) | 0 / 2 |

Common flags on the index-touching commands (`index`, `check`, `map`, `get`,
`list`, `query`, `relations`, `resolve`, `propagation`, `provenance`, `gate`,
`serve`):

| Flag | Effect |
| --- | --- |
| `--out <path>` | Index DB path override. Must resolve inside `platformDir` (exit 2 otherwise). |
| `--no-prompt` | Suppress the member-onboarding prompt. |
| `--json` | Machine output (all except `serve`). |
| `--fresh` | Read commands only: delete the DB plus WAL/SHM and reindex before answering. |

`init`, `domain list`, `req` register `--json` only. `domain new` registers none.

**Index freshness.** Read commands (`map`, `get`, `list`, `query`, `relations`,
`resolve`, `propagation`, `provenance`) build the index when it is missing and otherwise
trust it. A warm index older than a changed `SPEC.json` produces a stderr
warning. Tag-only code edits are not detected. `gate` always rebuilds cold, and
so does `check --ci`. After editing specs or tags, pass `--fresh`.

## Per-command reference

### spec index

Build or refresh the derived index.

`--json`: `{ build_id, repos, domains, requirements, tags, diagnostics }`.

Exit: 0 built / 1 crashed mid-index / 2 not a platform or bad args.

- `build_id` is deterministic for identical inputs (cold-rebuild equivalence).
- Also writes `.spec-engine/doctor.md`, a list of doc lines that mention a
  requirement id without an explicit `<!-- @spec ID -->` binding.

### spec check

Integrity, coverage, drift, and governance diagnostics.

| Flag | Effect |
| --- | --- |
| `--ci` | Delete the DB first. Correctness never trusts a warm index. |
| `--results <junit.xml>` | The trusted-red gate: a verifying tag counts only when its test passed. Path resolves inside `platformDir`. |
| `--base <ref>` | Diff the requirement set against a git ref (deletion and status-flip governance). |
| `--approved-by <list>` | Approver set for the status-flip check. |
| `--require-owner-approval` | Escalate `UNAPPROVED_STATUS_FLIP` from warning to error. |
| `--unsourced-change` | Also warn on superseded requirements with no `supersedes-via` issue. |

`--json` rows: `{ code, severity, repo, source_file, line, req_id, detail }`,
nullable except `code`, `severity`, `detail`, sorted deterministically.

Exit: 0 clean or warnings only / 1 any error-severity row / 2 usage.

Codes, in `DiagnosticCode` order:

| Code | Severity |
| --- | --- |
| `DUP_ID` | error |
| `BROKEN_SUPERSEDE` | error |
| `BAD_STATUS` | error |
| `DANGLING_TAG` | error |
| `SUPERSEDED_REFERENCED` | error |
| `DEPRECATED_REFERENCED` | error |
| `STATEMENT_GRAMMAR` | per domain, default warning |
| `DRAFT_REFERENCED` | warning |
| `GLOSSARY_DRIFT` | warning |
| `ORPHAN_REQ` | error |
| `UNVERIFIED_REQ` | error |
| `DRIFT` | error |
| `NO_SPEC_CONFIG` | warning |
| `BROKEN_FILE_REF` | error |
| `BROKEN_RELATES` | warning |
| `RELATES_SUPERSEDED` | warning |
| `CYCLIC_SUPERSEDE` | error |
| `SELF_RELATES` | warning |
| `UNKNOWN_ROLE` | warning |
| `UNSOURCED_CHANGE` | warning, only with `--unsourced-change` |
| `INVALID_DOMAIN_FILE` | error |
| `UNPROVEN_REQ` | error, only with `--results` |
| `PROOFS_UNCONFIRMED` | warning, only without `--results` |
| `REQUIREMENT_REMOVED` | error |
| `UNAPPROVED_STATUS_FLIP` | warning; error with `--require-owner-approval` |
| `PARTIAL_PROPAGATION` | error, needs `--base` and `--results` |
| `MALFORMED_FILE` | platform-map's severity: error, or warning for a manifest |
| `MEMBER_MISSING` | warning |
| `MARKER_MISSING` | warning |
| `MARKER_MISMATCH` | error |
| `UNLISTED_REPO` | warning (platform-map info, promoted) |
| `PLATFORM_NOT_LOCATED` | warning |
| `UNDECLARED_PLATFORM` | warning (platform-map info, promoted) |
| `SCAN_TRUNCATED` | warning |
| `UNDEFINED_TERM` | error |
| `ORPHAN_TERM` | warning |
| `TERM_DRIFT` | warning |
| `SUPERSEDED_TERM_REFERENCED` | error |

The four TERM codes are the last four rows. Only `error` rows drive exit 1.
The eight codes before them are platform-map's, surfaced with the
platform-map code (CHCK-031): every platform-map error and warning keeps
its severity; `UNLISTED_REPO` and `UNDECLARED_PLATFORM` are promoted from
info to warning because they mean a repository's tags are not scanned;
`UNMATCHED_PATTERN` and `AMBIGUOUS_ECOSYSTEM` are not surfaced. `repo` is
the diagnostic's subject when it names a member; `source_file` is the
subject. `NO_SPEC_CONFIG` stays Spec Engine's own code: a declared member
present on disk with no `spec-engine.member.json`.

- Deletion detection runs by default: with no `--base`, the working tree is
  diffed against `HEAD` whenever git resolves. An Active requirement absent
  from the tree without a same-change supersession is `REQUIREMENT_REMOVED`.
  History (superseded and deprecated entries) may never be deleted. Outside
  git the check stays quiet.
- `BROKEN_SUPERSEDE` covers both stored directions: a `supersededBy` naming a
  missing id, and a `supersedes` naming a missing id or the entry itself.
- `BROKEN_FILE_REF`: an Active/Draft entry's `livesIn` does not resolve to a
  file under the platform root. Terminal-status entries are exempt.
- Without `--results`, `check` emits `PROOFS_UNCONFIRMED` and skips proof
  enforcement. The results file is never hashed into `build_id`. Generate it
  with `bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml`.
- Term citations: `UNDEFINED_TERM` (error) is a `cites` entry resolving to no
  TERM; `SUPERSEDED_TERM_REFERENCED` (error) cites a superseded term;
  `TERM_DRIFT` (warning) is a pin behind the term's current version;
  `ORPHAN_TERM` (warning) is an Active term nothing cites. The first three
  clear with `spec term confirm`.

### spec guard

The pre-commit loss gate. Diffs the requirement derivation at `--against <ref>`
(default `HEAD`) against the working tree, scoped to the files in `git diff`.
Rebuilds the worktree index cold every run.

`--json` rows: `{ kind, req_id, file, line, detail }`, sorted by
`(req_id, kind, file, line)`. `kind` is one of `REQUIREMENT_REMOVED`,
`IMPL_LOST`, `VERIFY_LOST`, `SPEC_FILE_DELETED` (`req_id` null).

Exit: 0 clean / 1 any loss / 2 usage.

- A loss is suppressed only by ending the requirement in the same change:
  supersede it (either direction) or `spec deprecate` it. There is no override
  comment.
- A non-git tree, a repo with no `HEAD`, or an unknown ref prints
  `NOT_A_GIT_REPO` to stderr and exits 0.
- Text mode prints a `🛑 spec-guard:` block per requirement, written in the
  second person. Relay it verbatim to the user before proceeding.

### spec map

`--json` rows keyed `(req_id, repo)`: `{ req_id, domain_key, req_status,
req_spec_version, req_changed_at_version, repo, repo_pin, implemented: 0|1,
verified: 0|1, test_levels }`. Text mode renders `src`, `test`, `src+test`, `—`.

Exit: 0 / 2.

### spec get

One requirement's full record from the derived index.

`--json`: the `Requirement` row `{ id, key, seq, status, superseded_by, text,
why, source_file, line, spec_version, changed_at_version,
superseded_at_version }`, the same object `GET /api/requirements/:id` serves.
Text mode is a one-row table: `ID STATUS KEY SEQ CHANGED_AT TEXT`.

Exit: 0 / 2. An unknown id prints `[]` on stdout, guidance on stderr, and
exits 0. A malformed id exits 2.

### spec list

Every requirement record in (key, seq) order. Unlike `query`, superseded and
deprecated rows are included and nothing is ranked.

| Flag | Effect |
| --- | --- |
| `--domain KEY` | Only that domain (case-insensitive key). |
| `--status S` | Only that status: `active`, `draft`, `superseded`, `deprecated`. Any other word exits 2. |

`--json`: an array of `Requirement` rows, the same rows `GET /api/requirements`
serves. Text mode is the `ID STATUS KEY SEQ CHANGED_AT TEXT` table.

Exit: 0 / 2. An empty result is `[]` under `--json`, guidance on stderr in
text mode, exit 0.

### spec query

FTS5 `MATCH` syntax. `--limit N` (default 10, max 1000).

Exit: 0 / 2 (bare `AND` or `OR` is an FTS5 grammar error).

- Wrap multi-word phrases in double quotes inside the shell-quoted arg.
- Results rank ascending (best first). Superseded requirements are excluded.
- Glossary term definitions ride the same index. A matching term appears in a
  separate Terms group in text mode, discriminated by `key` under `--json`.

### spec relations

Text mode: mermaid `graph LR`, one node per requirement in a `relates` field,
one undirected deduped edge per pair. `--json` rows:
`{ from_id, to_id, source_file, line }`, sorted by (from, to).

Exit: 0 / 2. Empty graph is `[]` and exit 0.

### spec provenance

Per requirement: the creating issue, the revising issues (`supersedes-via`,
`amends-via`), the backing tests, and the `source_file:line` pointer.

| Flag | Effect |
| --- | --- |
| `[issueId]` positional | Display-only reverse filter. Never a join key. |
| `--resolve-issues` | Overlay tracker title/status/URL. Needs `SPEC_TRACKER_TOKEN`; degrades to bare ids without it. |

`--json` rows: `{ req_id, role, issue_id, source_file, line, req_status,
implemented, verified, test_levels }`, sorted on the full composite key.

Exit: 0 / 2. Empty matrix is `[]` and exit 0.

### spec resolve

Accepts multiple positionals, comma-split inside one positional, and absolute
paths under the platform dir. See "Path rules" below.

| Flag | Effect |
| --- | --- |
| `--req KEY-NNN` | Reverse query: every tag site for that requirement. Takes no file positionals. |

`--json` rows (`--req`): `{ req_id, repo, file, line, kind, level }` sorted by
(repo, file, line). `kind` is `implements`, `verifies`, or `documents`.

Exit: 0 / 2. Empty result is `[]` and exit 0. Unknown id under `--req` is `[]`.

### spec propagation

One row per member repo: `{ repo, state, via_req_id, drifted }`. `state` is one
of `MIGRATED_VERIFIED`, `MIGRATED_UNVERIFIED`, `ON_PREDECESSOR`,
`ON_OTHER_DOMAIN_REQ`, `NO_DOMAIN_REFERENCE`.

Rows are in dependency order: a member comes after every member it depends
on, read from platform-map's `dependsOn` (the platform's own package names in
a member's manifest), and members at the same depth come by name. The same
order is served by `/api/propagation/:id`, `spec_propagation`, and the
webapp's `/propagation/:id` page. A platform with no in-platform dependencies
lists members by name.

Exit: 0 / 2.

### spec gate

`--json`: `{ pass, reason, repo, req_id, detail, status, changed_at_version,
pinned_spec_version }`. `reason` is one of `PASS`, `NOT_FOUND`, `DRAFT`,
`SUPERSEDED`, `DEPRECATED`, `VERSION_PIN`, decided in that order. Pin equality
passes.

Exit: 0 pass / 1 fail / 2 unknown repo name or bad args.

### spec init

Declares a member through platform-map and writes `spec-engine.member.json`.

| Flag | Effect |
| --- | --- |
| `--specs spec-engine@N` | Override the pin. |
| `--force` | Rewrite an existing config, preserving `ignore`. Any other key refuses, as does a malformed `ignore`. |
| `--platform <dir>` | The platform root, for a declared member checked out outside the platform folder. Its location is recorded in platform-map's per-user file first. |

`--json`: `{ action: "wrote", path, pin, source, declared, linked }` or
`{ action: "already-configured", path, pin, extra_fields, declared, linked }`.
`declared` lists the platform-map files written (the platform file, the
marker), empty when the member was already declared; `linked` is the
per-user file written under `--platform`, else null.

Exit: 0 wrote or already configured / 2. Branch on `action`, not the exit code.

- Where the target sits decides what is written (INIT-038):
  - a repository directly under a platform folder (a directory holding
    `spec-engine/`) that the platform file does not list is declared: a
    `platform-map.json` platform file entry at the root (the file is created
    when absent) and a `{ platform, member }` marker in the repository, then
    the pin. platform-map declares only a directory with a `.git` entry or a
    `package.json`; a plain folder is refused with exit 2;
  - a declared member only gets the pin (a missing marker is written back);
  - a workspace package of a monorepo gets a nested pin and no declaration;
    a repository inside a lone monorepo that is not a workspace package is
    refused;
  - a directory under no platform gets the `spec-engine@1` fallback pin.
- The platform root is platform-map's `locate()` (INIT-034): the nearest
  `platform-map.json` or `.git` boundary, a marker resolved through the parent
  directory or the per-user file; the parent directory when it holds
  `spec-engine/`. A `.git` boundary between the target and an outer
  `spec-engine/` hides that platform, as before.
- Default pin: `--specs`, else the derived platform version, else
  `spec-engine@1` with a printed note.
- A resolved path with a `spec-engine` segment is refused, except on the
  engine's own checkout (root package named `@spec-engine/spec-engine`),
  where only the path below the platform root is judged.
- `ignore: ["dir", …]` excludes repo-relative directory prefixes from that
  repo's scans. The `members` glob is gone: a monorepo's columns are its
  workspace manifest's packages.

### spec domain

`spec domain new <KEY>` scaffolds `spec-engine/<KEY>/SPEC.json`.
`spec domain list` prints one key per line; `--json` prints a sorted array of
`{ key, scope }` (scope is the charter sentence or null), read from the
filesystem.

Exit: 0 / 2.

### spec migrate

One-time cutover: every canonical `SPEC.md` becomes a schema-validated sibling
`SPEC.json`, then the `SPEC.md` is deleted. Idempotent. No `--json`.

Exit: 0 / 2.

### spec req

| Mode | Behavior |
| --- | --- |
| stdin not a TTY, no `--text` | Print the bare next unused id (e.g. `BILLING-010`), exit 0. No prompts, no writes. |
| `--json`, no `--text` | Print `{ domain, next_id }`. Same zero-write contract, even on a TTY. |
| `--text "<statement>"` | Append an Active entry with zero prompts. `--why`, `--lives`, `--issue <ticket>` fill the other fields and error without `--text`. `--lives` repeats and comma-separates: `--lives a.ts --lives b.ts,c.ts` records all three. |
| `--draft` | Author the entry as Draft (with `--text`, or on a TTY). Off a TTY without `--text` it exits 2. |
| TTY, no flags | Interactive authoring. |

`--json` with `--text`: `{ id, file }`, plus `clauses: { pattern, condition,
system, response }` when the statement parses as EARS.

Exit: 0 / 2 (ambiguous prefix, unknown domain, grammar refusal).

- The domain prefix is case-insensitive: `bil` resolves to `BILLING`.
- The resolved domain's charter is echoed to stderr on every authoring path.
- Unresolvable `@<path>` refs warn on stderr and never block.

### spec term

A term is a requirement row in the reserved `TERM` domain: definition in
`statement`, headword in `term`, synonyms in `aliases`.

| Form | Effect |
| --- | --- |
| `spec term "<name>" --def "<definition>" [--aliases a,b] [--section s]` | Append a `TERM-NNN`. `--json`: `{ id, file }`. |
| `spec term` with no `--def` | Pure id query, mirrors `spec req`: bare next `TERM` id, or `{ domain, next_id }`. |
| `spec term list` | `id  name  status` per line, or `[{ id, term, status }]`. Reads the filesystem. |
| `spec term revise <TERM-NNN> --def "…"` | Rewrite the definition in place and bump the TERM envelope's `specVersion`. `--no-bump` opts out. `--json`: `{ id, file, spec_version }`. |
| `spec term confirm <KEY-NNN> <TERM-NNN>` | Re-pin a citation to the term's current version (clears `TERM_DRIFT`); re-point to the successor when the term is superseded (clears `SUPERSEDED_TERM_REFERENCED`). `--json`: `{ req_id, term_id, pinned, file }`. |

`spec supersede TERM-NNN` and `spec amend TERM-NNN --term/--aliases` work on
term ids as on requirements.

Exit: 0 / 2.

### spec glossary

| Form | Effect |
| --- | --- |
| `spec glossary` | Overwrite `GLOSSARY.md` from the TERM store. Byte-stable: fixed header, terms in id order, `## {section}` once per change, one `- **{term}** — {statement}` bullet each. |
| `--migrate` | One-time parse of an existing `GLOSSARY.md` into `TERM-001..N`. Skips when the TERM domain already has entries. |
| `--check` | Regenerate into a buffer and diff against the committed file. Exit 1 on drift. What `fence_glossary_roundtrip` runs. |

`--json`: `{ generated }`, `{ migrated }`, or `{ ok }`.

Exit: 0 / 1 (`--check` drift) / 2.

### spec deprecate

Marks an Active/Draft requirement `deprecated`, records `--reason` on the
entry, and prints the cleanup worklist of tags still bound to the id.

Exit: 0 / 2.

### spec supersede

Requires an Active target. Flips it to `superseded by NEW`, mints the successor
in the same domain, reindexes fresh, and prints the retag worklist (the sites
`check` reports as `SUPERSEDED_REFERENCED` until retagged).

| Flag | Effect |
| --- | --- |
| `--text` | The successor statement. Required when not a TTY. |
| `--why`, `--lives` | Successor fields. Default to copies of the predecessor's. `--lives` repeats or comma-separates and replaces the whole list; an empty value clears it. |
| `--issue <ticket>` | Recorded as `supersedes-via` on the predecessor and `created` on the successor. |
| `--no-bump` | TERM domain only: keep the authored `specVersion`. No-op elsewhere. |

`--json`: `{ old_id, new_id, file, spec_version, retag: [{ req_id, repo, file,
line, kind, level }] }`. On a requirement domain `spec_version` is the derived
domain version after the supersession, and the same number is stamped as the
predecessor's `supersededAtVersion`.

Exit: 0 / 2. All guards run before the first byte is written.

### spec move

Cross-domain supersede. Mints the successor as the next id in `<NEW-DOMAIN>`
(which must exist), copies `statement`, `why`, `livesIn` (`--text`, `--why`,
`--lives` override), flips the source to superseded with a cross-domain
`supersededBy`, and prints the retag worklist.

`--json`: `{ old_id, new_id, from_file, to_file, source_spec_version,
target_spec_version, retag: [...] }`.

Exit: 0 / 2 (non-Active source, or the target is the source's own domain).

- Both envelopes validate before either is written.
- The source version advances; the target version is unchanged.

### spec amend

Revise an Active or Draft entry in place. Same id, no version change.

| Flag | Effect |
| --- | --- |
| `--text`, `--why`, `--lives` | Field to change. At least one flag is required. Untouched fields stay byte-identical. `--lives` repeats or comma-separates and replaces the whole `livesIn` list (the `--aliases` idiom); `--lives ""` clears it. |
| `--issue <ticket>` | Append `amends-via` provenance. |
| `--term`, `--aliases` | TERM ids only. |

`--json`: `{ id, file, fields_changed }`.

Exit: 0 / 2 (superseded or deprecated target; an Active entry that code already
tags, which is shipped and must be superseded instead).

### spec accept

Promotes a Draft requirement to Active. Every other field stays byte-identical
and the domain version does not move. Reword a draft with `spec amend` first;
end one with `spec deprecate`.

`--json`: `{ id, file }`.

Exit: 0 / 2 (the target is not Draft: nothing is written).

- A Draft never raises `ORPHAN_REQ` or `UNVERIFIED_REQ` and is not counted in
  the coverage report. A code tag on one is `DRAFT_REFERENCED` (warning), and
  its `livesIn` is still checked by `BROKEN_FILE_REF`.

### spec serve

Binds one address: `127.0.0.1`, or `--host <ip>` (a literal loopback,
RFC 1918, or `100.64/10` address only; anything else exits 2). `--port 0`
(default) picks a free port. `--probe` boots on loopback, fetches `/`, and
exits 0 or 1. The startup line, `/api/platform` (`name`), and every
page's title and sidebar name the platform (platform file `name`, else the
directory name), never a path; `spec mcp` logs the same name on stderr.

A non-loopback `--host` is LAN mode: stdout prints
`http://<ip>:<port>/?token=…`; every request needs that token (the query
parameter is exchanged for an `HttpOnly; SameSite=Strict` cookie, then a 302
drops it), else 401. A `Host` other than loopback or the bound address is
403. Read-only unless `--allow-writes`: non-GET requests, `/provenance`, and
`/api/provenance?resolve=1` answer 403. `--token` / `SPEC_SERVE_TOKEN` pin
the token (≥ 16 of `A-Z a-z 0-9 _ -`); otherwise it is 256 random bits.

Always-on routes: `/`, `/requirements[/:id]`, `/propagation/:id`,
`/api/coverage`, `/api/report`, `/api/repos`, `/api/platform`,
`/api/requirements[/:id]`, `/api/propagation/:id`, `/api/resolve?files=…`.

Flag-gated, 404 until enabled. `SPEC_FLAGS` is comma-separated; unknown keys
are ignored.

| `SPEC_FLAGS` key | Routes |
| --- | --- |
| `query` | `/query`, `/api/query?q=&limit=` |
| `relations` | `/relations`, `/api/relations[?format=mermaid]` |
| `provenance` | `/provenance`, `/api/provenance[?resolve=1]`, `/api/provenance/by-issue?issue=` |
| `editor` | `/editor`, `POST` and `PUT /api/requirements`, `POST /api/requirements/:id/supersede`, `POST /api/requirements/:id/deprecate`, `POST /api/requirements/:id/accept` |
| `glossary`, `logs` | Placeholder pages |

Exit: 0 / 1 / 2.

### spec docs

Serves the prebuilt docs site (`packages/site`) on `127.0.0.1`, fully offline.

- Takes no platform dir. Registers none of `--json`, `--out`, `--no-prompt`.
- The npm artifact ships the site at `dist/docs/`. A checkout serves
  `packages/site/dist`; run `bun run build:site` first, else exit 2.
- `--probe` mirrors `serve --probe`.

Exit: 0 / 1 / 2.

### spec mcp

MCP server over stdio. Register it as
`{ "command": "spec", "args": ["mcp", "<platformDir>"] }`.

| Tool | Returns |
| --- | --- |
| `spec_query` | FTS hits, the `spec query --json` shape |
| `spec_resolve` | files → requirements |
| `spec_req_tags` | requirement → tag sites |
| `spec_coverage_report` | per-domain rollup `{ domain, active, implemented, verified, orphans, unverified }` |
| `spec_check` | diagnostic rows |
| `spec_propagation` | per-repo migration state |
| `spec_next_id` | `{ domain, next_id }`, nothing written |
| `spec_get` | one `Requirement` row, or `[]` for an unknown id; the `spec get --json` shape |
| `spec_list` | `Requirement` rows in (key, seq) order, `domain` and `status` filters; the `spec list --json` shape |
| `spec_supersede` | `{ old_id, new_id, file, spec_version, retag }`, the `spec supersede --json` shape |
| `spec_deprecate` | `{ id, file, reason, sites }`, the `spec deprecate --json` shape |
| `spec_accept` | `{ id, file }`, the `spec accept --json` shape |

Every tool call reindexes fresh. stdout is the protocol channel; chrome goes to
stderr. One prompt, `author_requirements` (`brief` required, `domain`
optional), returns a static authoring playbook with the brief and the domain's
charter substituted. The engine runs no model.

Exit: 0 / 2.

## Authoring requirements (brief → mint)

The full authoring standard (the eight rules and the fixed statement shapes) is
the "Requirement authoring standard" section of `spec-engine/TAXONOMY.md`. The
command choreography:

1. **Split the brief.** One requirement per behavior, never one per ticket.
2. **Place each.** `spec domain list --json` prints every charter. File the
   requirement where the promise lives.
3. **Dedup.** `spec query "<phrase>" . --json` before minting. Overlap means
   `spec amend` or relate the existing requirement.
4. **Draft to the standard.** Fixed EARS shape, checked at write time where the
   domain declares it. The why names what breaks. Every draft quotes the phrase
   of the brief it derives from.
5. **Mint.** `spec req <domain> --text "<statement>" --why "<what breaks>"
   --lives "<file>" [--issue <ticket>]`.
6. **Provenance, not identity.** The ticket goes in `--issue`, never in an id
   or a tag.
7. **Verify.** `spec index . && spec check . --ci` (exit 0) and `spec guard .`
   before the PR.

**Statement grammar.** A domain envelope may declare `grammar: "ears"` with
`grammarSeverity: "warning" | "error"` (default warning).

| Shape | Form |
| --- | --- |
| Always | `The <system> shall <result>` |
| Event | `When <trigger>, the <system> shall <result>` |
| State | `While <state>, the <system> shall <result>` |
| Failure | `If <failure>, then the <system> shall <result>` |
| Feature | `Where <feature>, the <system> shall <result>` |

- `spec check` reports a nonconforming Active/Draft statement as
  `STATEMENT_GRAMMAR` at the declared severity.
- `spec req`, `amend`, `supersede`, and `move` judge new text at write time:
  warn and write under warning, refuse (exit 2) under error.
- The TERM domain is exempt.

## The agent loop (route → tag → check)

Before changing code, load the requirements the task touches:

```
spec query "renewal charge" . --json          # by topic
spec resolve src/billing/renew.ts . --json    # by file
```

While implementing, bind new code to its requirement:

```ts
export function renew() { /* … */ }     // @spec BILLING-009
it("charges current price", () => {})   // @spec BILLING-009 unit
```

Before finishing:

```
echo | spec req bil                    # next unused BILLING id
spec index . --json                    # rebuild the derived index
spec check . --ci --json               # exit 1 ⇒ fix before PR
spec guard . --json                    # exit 1 ⇒ this change deletes a live requirement
```

When `spec guard` blocks you, relay the `🛑 spec-guard:` block verbatim to the
user, then either `spec supersede` the requirement with a successor or get the
user's explicit decision to `spec deprecate` it. Never delete a requirement to
make the gate pass.

## Path rules for `spec resolve`

`tags.file` is stored as `<repo>/<path>`.

- Multi-repo platform: pass `<repo>/<path>`, e.g. `spec resolve api/src/renew.ts .`
- Single repo: both the natural repo-relative path (`src/orders.ts`) and the
  basename-prefixed form are accepted. Prefer the natural form.
- Absolute paths are normalized against `platformDir`. A path outside it exits 2.

## Gotchas

- **`fixtures/` is globally ignored by the tag scanner.** Planted defects are
  test data.
- **The DB owns nothing.** Never edit `.spec-engine/index.sqlite`. Edit the
  `SPEC.json` source and re-run `spec index`.
- **`storage_unavailable` / `SQLITE_IOERR*` means your environment.** The index
  runs in WAL mode and needs real file locks. A sandboxed process gets
  `SQLITE_IOERR_VNODE`; re-run unsandboxed or grant write+lock access to
  `<platformDir>/.spec-engine/`. `SQLITE_BUSY` means another `spec` process
  holds the DB.
- **Empty ≠ error.** Read commands exit 0 with `[]` and guidance on stderr.
- **Determinism is contractual.** JSON outputs are sorted and byte-stable.
- A directory passed as the last positional is `platformDir` only if it
  contains `spec-engine/`. Otherwise it is treated as a file, with a warning.
