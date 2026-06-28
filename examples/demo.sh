#!/usr/bin/env bash
#
# Quilt demo — three actors, one checkout, clean commits.
#
# Runs the whole story in a throwaway git repo: two agents and you edit the
# same working tree, Quilt shows who owns what, catches a collision, and lands
# one agent's work as a clean commit while everyone else's stays put.
#
#   ./examples/demo.sh              # run it
#   QUILT=/path/to/dist/cli.js ./examples/demo.sh   # use a specific build
#   PACE=0 ./examples/demo.sh       # no pauses (for CI); default pauses for recording
#
set -euo pipefail

QUILT="${QUILT:-$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js}"
PACE="${PACE:-0.9}"
q() { node "$QUILT" "$@"; }
pause() { sleep "$PACE"; }
say() { printf "\n\033[1;36m# %s\033[0m\n" "$*"; pause; }

DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
cd "$DIR"

git init -q
git config user.email you@example.com
git config user.name "You"
git config commit.gpgsign false

cat > auth.ts <<'EOF'
export function login() {
  return true;
}
EOF
printf '# my-app\n' > README.md
git add -A
git commit -qm "initial"

# A formatter/generator rewrote a lockfile before anyone started a session —
# Quilt will leave it unclaimed (nobody owns it).
echo "generated = true" > config.lock

say "Set up Quilt in a normal git repo — no worktrees, no daemon."
q init

say "Two agents and you start sessions in the SAME checkout."
q start --actor codex --type agent >/dev/null
q start --actor claude-ui --type agent >/dev/null
q start --actor you --type human >/dev/null

say "codex adds a function to auth.ts ..."
cat > auth.ts <<'EOF'
export function login() {
  return true;
}

export function validateSession() {
  return checkToken();
}
EOF
QUILT_ACTOR=codex q status >/dev/null

say "... claude-ui creates a new file ..."
cat > theme.ts <<'EOF'
export const theme = "dark";
EOF
QUILT_ACTOR=claude-ui q status >/dev/null

say "... and you edit the README."
printf '# my-app\n\nA small app.\n' > README.md
QUILT_ACTOR=you q status >/dev/null

say "quilt status — who owns what, in one checkout:"
QUILT_ACTOR=codex q status
pause

say "codex commits ONLY its own work:"
QUILT_ACTOR=codex q commit --mine -m "add validateSession"
pause

say "git log — a normal commit, authored by the agent:"
git log --oneline --pretty="  %h  %an: %s" -2
pause

say "And everyone else's work is still right here in the tree:"
git status --short
pause

say "Same repo. Many agents. Clean commits."
