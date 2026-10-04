#!/usr/bin/env bash
#
# Sourced by every scripts/smoke/NN-*.sh. A smoke runs from the repo root
# against the compiled binary (SPEC_BIN overrides ./dist/spec) and the
# canonical planted fixture, and exits non-zero on the first failed assertion.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

SPEC="${SPEC_BIN:-./dist/spec}"
FIXTURE=fixtures/platform-fixture
BASELINE=fixtures/platform-fixture.diagnostics.json
# shellcheck disable=SC2034
FIXTURE_DB="$FIXTURE/.spec-engine/index.sqlite"

test -x "$SPEC" || { echo "FAIL: $SPEC is not executable; run: bun run build:cli"; exit 1; }

fail() { echo "FAIL: $*"; exit 1; }

# The build_id `spec index --json` reports for a platform dir.
build_id() { "$SPEC" index "$1" --json | jq -r '.build_id'; }

# The parse-layer diagnostic count `spec index --json` reports.
index_diagnostics() { "$SPEC" index "$1" --json | jq -r '.diagnostics'; }

is_sha256() { grep -qE '^[0-9a-f]{64}$' <<<"$1"; }

# Delete an index plus its WAL and SHM siblings so the next run rebuilds cold.
cold() { rm -f "$1" "$1-wal" "$1-shm"; }

# Diagnostic rows (a JSON array on stdin) as sorted `CODE<TAB>repo<TAB>req_id` lines.
project_diagnostics() { jq -r '.[] | "\(.code)\t\(.repo // "")\t\(.req_id // "")"' | sort; }

# The planted baseline in the same projection.
baseline_diagnostics() { project_diagnostics < "$BASELINE"; }

# Assert two projections are equal; print both and their diff otherwise.
expect_same() {
  local label=$1 got=$2 expected=$3
  if [ "$got" != "$expected" ]; then
    echo "FAIL: $label"
    echo "--- GOT ---"; echo "$got"
    echo "--- EXPECTED ---"; echo "$expected"
    echo "--- DIFF ---"; diff <(echo "$got") <(echo "$expected") || true
    exit 1
  fi
}

# A throwaway copy of the fixture with no index. The caller owns its removal.
fixture_copy() {
  local dir
  dir=$(mktemp -d)
  cp -R "$FIXTURE/." "$dir/"
  rm -rf "$dir/.spec-engine"
  echo "$dir"
}

# Commit a directory as the baseline of a fresh git repo.
git_baseline() {
  git -C "$1" init -q
  git -C "$1" -c user.email=ci@spec.local -c user.name=ci add -A
  git -C "$1" -c user.email=ci@spec.local -c user.name=ci commit -q -m baseline
}

# Start `spec serve` on a free port in the background and wait up to ten
# seconds for its ready line. Sets SERVE_PID and PORT; the caller traps
# `serve_stop`. Extra arguments are environment assignments for the server.
serve_start() {
  local dir=$1; shift
  SERVE_LOG=$(mktemp)
  env "$@" "$SPEC" serve "$dir" --port 0 > "$SERVE_LOG" 2>&1 &
  SERVE_PID=$!
  PORT=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if grep -qE 'spec: serving .+ on http://127\.0\.0\.1:' "$SERVE_LOG" 2>/dev/null; then
      PORT=$(grep -oE 'http://127.0.0.1:[0-9]+' "$SERVE_LOG" | head -1 | grep -oE '[0-9]+$')
      break
    fi
  done
  test -n "$PORT" || { echo "FAIL: server did not print its ready line within 10s"; cat "$SERVE_LOG" || true; exit 1; }
  echo "spec serve bound to 127.0.0.1:$PORT"
}

serve_stop() {
  kill "${SERVE_PID:-}" 2>/dev/null || true
  sleep 1
  rm -f "${SERVE_LOG:-}"
}
