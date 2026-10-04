# Spec Engine

**Catch cross-repo spec drift in one local command.**

Spec Engine walks a whole platform, a canonical `spec-engine/` spec repo plus every
member repo that pins it, and tells you across all of them at once who shipped a
requirement, who verified it, and who is still stuck on a superseded version.

```console
$ spec propagation BILLING-009 ./platform
REPO    STATE                VIA          DRIFT?
admin   ON_OTHER_DOMAIN_REQ  BILLING-007  no
api     MIGRATED_VERIFIED    —            no
mobile  ON_PREDECESSOR       BILLING-001  yes     ← drifted: still on the superseded req
```

`BILLING-009` shipped. `api` migrated and proved it. `admin` does not use it. `mobile`
is still on `BILLING-001`, the requirement `BILLING-009` replaced. That is drift, found
in one command.

## The idea

Everything in Spec Engine follows from eight statements:

1. A requirement represents a single behavior.
2. A requirement is never deleted. When behavior changes, it is superseded or deprecated.
3. The written requirements are the single source of truth for what the software is supposed to do.
4. A requirement can be linked to the code that implements it and to the tests that prove it.
5. Reports are computed from the requirements and their links.
6. You can check whether the requirements, code, and tests agree, and exactly where they don't.
7. Tickets are not requirements. A ticket is temporary work; requirements outlive it.
8. Requirements are written in a fixed shape (when X happens, the system shall do Y).

The file format, the tags, and the commands are implementation of these.

## Install

One npm package. Needs [Bun](https://bun.sh) 1.3 or newer (the engine uses `bun:sqlite`
and does not run under Node).

```bash
bunx @spec-engine/spec-engine --help    # run without installing
bun add -g @spec-engine/spec-engine     # or install the `spec` bin globally
```

The package carries the `spec` CLI, the local webapp (`spec serve`), and the docs site
offline (`spec docs`).

## First run

In any repo of your own:

```bash
spec domain new ORDERS                                       # scaffold a domain
spec req orders --text "An order total equals the sum of its line items." \
    --why "Mispriced orders ship money out the door silently."   # author ORDERS-001
spec map .                                                   # coverage matrix
spec check .                                                 # integrity gate
```

### Or explore the planted fixtures

This repo ships `fixtures/platform-fixture`: a canonical `spec-engine/` and three member
repos (`admin`, `api`, `mobile`) with drift deliberately planted. Fixtures are test data,
not part of the npm package, so this path needs a checkout:

```bash
git clone https://github.com/spec-engine/spec-engine && cd spec-engine
bun install
alias spec="bun packages/engine/src/cli.ts"     # or: bun run build:cli && ./dist/spec
```

The coverage matrix, every requirement by every repo:

```console
$ spec map fixtures/platform-fixture
DOMAIN   REQUIREMENT  STATUS      admin     api       mobile  spec-engine
AUTH     AUTH-001     Active      —         —         —       —
BILLING  BILLING-001  Superseded  —         —         src     —
BILLING  BILLING-002  Active      —         src       —       —
BILLING  BILLING-007  Active      src+test  src+test  src     —
BILLING  BILLING-009  Active      —         src+test  —       —
```

Each cell: `src` (implemented), `test` (verified), `src+test` (both), `—` (nothing).

Integrity: dangling tags, drift, orphans, superseded references:

```console
$ spec check fixtures/platform-fixture
DANGLING_TAG          admin   admin/src/reports.ts:2   BILLING-999  references non-existent requirement
DRIFT                 mobile  mobile/src/billing.ts:1  BILLING-001  pinned @1, requirement changed at @2
SUPERSEDED_REFERENCED mobile  mobile/src/billing.ts:1  BILLING-001  superseded by BILLING-009
ORPHAN_REQ                    spec-engine/AUTH/SPEC.json:8  AUTH-001  active requirement, no implementing tag
UNVERIFIED_REQ                spec-engine/BILLING/SPEC.json  BILLING-002  implemented but never verified
```

That is the whole loop: write specs, tag code, check the platform.

## How it works

Three parts. The important one owns nothing.

1. **Canonical specs** live in `spec-engine/<DOMAIN>/SPEC.json`. Each requirement has a
   permanent id like `BILLING-009` and a status (`active`, `superseded`, `draft`,
   `deprecated`). This is the only source of truth.
2. **Code points back** with a tag: `// @spec BILLING-009`. A tag in source code
   implements the requirement. A tag in a test file proves it. You never write those
   words in the tag.
3. **A derived index** (`.spec-engine/`, a disposable SQLite database) is built from 1
   and 2. Delete it and rebuild and you get a byte-identical result. Coverage is a SQL
   view over the tags, so it cannot drift from them.

| Thing | Where it lives | Who writes it |
| --- | --- | --- |
| Requirement | `spec-engine/<DOMAIN>/SPEC.json` | You, through `spec req`, `spec supersede`, `spec amend` |
| Tag | `// @spec KEY-NNN` in code | You |
| Index | `.spec-engine/index.sqlite` | The engine. Never commit it, never edit it |
| Membership | `platform-map.json`: the platform file `{ name, members }` at the root, a `{ platform, member }` marker in each member | `spec init`, through `@spec-engine/platform-map` |
| Member pin | `spec-engine.member.json`, `{ "specs": "spec-engine@N" }` | `spec init` |
| Domain version | Derived from the domain's supersede history | Nobody. It advances by one per supersession |
| Platform version | The highest domain version | Nobody. It is what `spec init` pins a new member to |

Drift is a member pinned below the version at which a requirement it references last
changed. Supersede `BILLING-001` and every member still pinned at `@1` that references
it lights up. A declared member with no `spec-engine.member.json` is reported as
`NO_SPEC_CONFIG`, and a repository in the platform folder that nobody declared as
`UNLISTED_REPO`, rather than silently ignored.

`SPEC.json` is the only spec format. `spec migrate` was the one-time cutover from the
legacy Markdown specs.

See the [architecture page](https://docs.spec-engine.dev/architecture/) for the
components, the single seams, and the invariants.

## Commands

| Command | What it does |
|---|---|
| `spec map <dir>` | Platform-wide coverage matrix (requirement × repo) |
| `spec check <dir>` | Integrity + drift diagnostics; `--ci` for a cold, gate-able run |
| `spec guard <dir>` | Block a change that deletes a requirement, its last tag, or its test without superseding |
| `spec propagation <REQID> <dir>` | Per-member migration state for one requirement |
| `spec query <text> <dir>` | Full-text search across requirements |
| `spec resolve <files…>` | Map changed files to the requirements they touch |
| `spec req` / `spec supersede` / `spec amend` / `spec deprecate` / `spec accept` | Author and evolve requirements |
| `spec init <repo>` | Declare a member and write its `spec-engine.member.json` |
| `spec gate` / `spec relations` / `spec provenance` | Approval gate, cross-refs, provenance |
| `spec serve <dir>` | Local webapp over the index |
| `spec mcp` | The same engine over the Model Context Protocol |

`--help` on any command lists its flags. `--json` on the read commands emits
deterministic output for scripting.

## CI gate

`spec check <dir> --ci` builds a fresh index and exits 1 on any error-severity
diagnostic. Add `--results` with your test runner's JUnit XML to arm the trusted-red
gate: a requirement counts as proven only when a passing test verifies it.

```bash
bun test --reporter=junit --reporter-outfile=.spec-engine/results.xml
spec check . --ci --results .spec-engine/results.xml
```

## Loss guard

`spec check` sees only the current tree, so deleting a requirement together with its
tags and tests leaves a smaller index that is still consistent. `spec guard` diffs the
requirement derivation at a git ref (default `HEAD`) against your working tree and
blocks what is about to be lost.

```console
$ spec guard .
🛑 spec-guard: BILLING-009 is Active and this change deletes its only implementation
(src/billing.ts:12) and its verifying test. Requirements are superseded, never deleted.
Either run `spec supersede BILLING-009` with a successor, or run
`spec deprecate BILLING-009 --reason "..."` to end it with a recorded reason.
```

- Exit 1 on any loss, 0 when clean. Outside a git repo it warns and exits 0.
- There is no override comment. A loss is suppressed only by ending the requirement in
  the same change: `spec supersede` with a successor, or `spec deprecate --reason`.

As a pre-commit hook (lefthook shown; a bare `.git/hooks/pre-commit` works too):

```yaml
# lefthook.yml
pre-commit:
  commands:
    spec-guard:
      run: spec guard . || exit 1
```

As a Claude Code hook, so an agent is stopped the moment an edit would lose a requirement:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "spec guard ." }] }
    ]
  }
}
```

## Local webapp

```console
$ spec serve . --port 4319
spec: serving on http://127.0.0.1:4319
```

`--port 0` (the default) picks a free port. The webapp reads the index, so run
`spec index . --fresh` after editing specs or tags.

| Route | Status |
| --- | --- |
| `/`, `/requirements`, `/requirements/:id`, `/propagation/:id` | Always on |
| `/api/coverage`, `/api/report`, `/api/repos`, `/api/platform`, `/api/requirements[/:id]`, `/api/propagation/:id`, `/api/resolve?files=…` | Always on |
| `/query`, `/api/query?q=` | `SPEC_FLAGS=query` |
| `/relations`, `/api/relations` | `SPEC_FLAGS=relations` |
| `/provenance`, `/api/provenance` | `SPEC_FLAGS=provenance` |
| `/editor`, `POST` / `PUT /api/requirements` | `SPEC_FLAGS=editor` |
| `/glossary`, `/logs` | `SPEC_FLAGS=glossary`, `SPEC_FLAGS=logs` (placeholders) |

Flags are comma-separated: `SPEC_FLAGS=query,relations spec serve .`. An off feature
shows "coming soon" in the nav and answers 404 on its endpoints.

### Access

By default there is no login or API key. Access is decided by where the request comes
from:

- The server binds one address: `127.0.0.1` unless `--host` names another.
- A request whose `Host` header is neither a loopback name nor the bound address is
  rejected, which blocks DNS rebinding.
- Write routes reject a cross-origin `Origin` header.

### LAN mode

To open the webapp from another machine on the same private network:

```bash
spec serve --host 192.168.1.141 --port 4400 .
# spec: serving on http://192.168.1.141:4400/?token=…
```

- `--host` takes only a literal loopback, RFC 1918 (`10/8`, `172.16/12`,
  `192.168/16`), or `100.64/10` (Tailscale) address. `0.0.0.0`, `::`, hostnames, and
  public addresses are refused.
- Every request needs the access token. Opening the printed URL swaps the token for an
  `HttpOnly; SameSite=Strict` cookie and drops it from the address bar. Anything
  without it gets 401.
- The token is random per start. Pin one with `--token` or `SPEC_SERVE_TOKEN`
  (at least 16 of `A-Z a-z 0-9 _ -`).
- The server is read-only: editor writes and tracker resolution (the provenance page)
  answer 403. Pass `--allow-writes` to permit them.
- `--probe` always binds loopback.

### Tracker token

`SPEC_TRACKER_TOKEN` is the one secret in the system, and it is not for the webapp. It
lets `spec provenance` and the provenance page resolve an issue id like `ENG-1234` to its
title, state, and URL.

- Optional. Without it, provenance shows the bare issue ids and a hint.
- Read once from the environment. Sent as a raw `Authorization` header (no `Bearer`
  prefix, a Linear quirk) in a read-only GraphQL query.
- Never logged. Never affects coverage, drift, or the gate.

## For agents

[AGENTS.md](AGENTS.md) is the machine-facing reference: the route → tag → check loop,
the exit-code contract, and every `--json` shape. `spec mcp` exposes the same engine over
the Model Context Protocol.

## Status

Proof of concept. Pre-1.0: the spec format and command surface may change.

Supported platforms: macOS and Linux. The scanner matches `/`-separated paths, so
Windows is not yet supported. CI runs on `macos-14` and `ubuntu-latest`.

## License

MIT. See [LICENSE](LICENSE).
