#!/usr/bin/env bash
#
# Quilt demo: the coordination layer for agent fleets.
#
# Runs the whole story in a throwaway git repo. Two agents share ONE checkout
# and coordinate through Quilt: they claim different functions in the same file
# without contending, one gets a heads-up that a function it depends on is being
# changed, and each lands only its own work as a clean, correctly-attributed
# commit.
#
#   ./examples/demo.sh                                # run it
#   QUILT=/path/to/dist/cli.js ./examples/demo.sh     # use a specific build
#   PACE=0 ./examples/demo.sh                         # no pauses (for CI)
#
set -euo pipefail

QUILT="${QUILT:-$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js}"
PACE="${PACE:-0.9}"
q() { node "$QUILT" "$@"; }
pause() { [ "$PACE" = "0" ] || sleep "$PACE"; }
say() { printf "\n\033[1;36m# %s\033[0m\n" "$*"; pause; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
cd "$DIR"

git init -q
git config user.email you@example.com
git config user.name "You"
git config commit.gpgsign false

cat > billing.js <<'EOF'
export function rate() {
  return 0.05;
}

export function total(amount) {
  return amount * rate();
}
EOF
git add -A
git commit -qm "initial"

say "Set up Quilt in a normal git repo. No worktrees, no daemon, no account."
q init

say "Two agents start sessions in the SAME checkout."
q start --actor codex --type agent >/dev/null
q start --actor claude --type agent >/dev/null

say "They claim DIFFERENT functions in the same file. No false contention:"
QUILT_ACTOR=codex q claim billing.js#rate
QUILT_ACTOR=claude q claim billing.js#total

say "claude was told, at claim time, that a function it depends on is changing."
say "Now each agent edits only its own function ..."
cat > billing.js <<'EOF'
export function rate() {
  return 0.07;
}

export function total(amount) {
  return amount * rate() + fee();
}
EOF
QUILT_ACTOR=codex q status >/dev/null
QUILT_ACTOR=claude q status >/dev/null

say "codex commits ONLY rate():"
QUILT_ACTOR=codex q commit --mine -m "raise rate to 0.07"
pause

say "claude commits ONLY total():"
QUILT_ACTOR=claude q commit --mine -m "add fee to total"
pause

say "git log: two clean commits, each authored by the agent that made it:"
git log --pretty="  %h  %an: %s" -2
pause

say "Parallelism through coordination, not isolation. Same repo. Many agents. Clean commits."
