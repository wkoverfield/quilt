#!/usr/bin/env bash
#
# Quilt fleet demo — the ceiling: run MORE agents on one repo.
#
# Seven agents fan out on ONE shared checkout (six on distinct functions, one
# that collides), head to head: plain git vs Quilt. It shows the two things that
# force people back down to fewer agents —
#   1. throughput: six clean per-agent commits vs one tangled blob, and
#   2. safety:     a collision prevented vs a silent overwrite (lost work).
# Agents are driven through the REAL Quilt machinery — the native-edit hooks and
# `commit --mine`, each with its own QUILT_ACTOR, exactly what an orchestrator's
# per-agent processes do. Nothing here is faked; run it yourself.
#
#   ./examples/fleet.sh                             # run it
#   QUILT=/path/to/dist/cli.js ./examples/fleet.sh  # use a specific build
#
set -u
QUILT="${QUILT:-$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js}"
PACE="${PACE:-0}"                 # set e.g. 0.5 to watch it unfold (used for the GIF)
p() { [ "$PACE" = "0" ] || sleep "$PACE"; }
q() { node "$QUILT" "$@"; }
b() { printf "\033[1m%s\033[0m\n" "$*"; }
red() { printf "\033[31m%s\033[0m\n" "$*"; }
grn() { printf "\033[32m%s\033[0m\n" "$*"; }
dim() { printf "\033[2m%s\033[0m\n" "$*"; }

seed_repo() {
  cd "$1" || exit 1
  git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false
  cat > api.js <<'EOF'
export function getUser(id)    { return db.find("user", id); }
export function getPost(id)    { return db.find("post", id); }
export function getComment(id) { return db.find("comment", id); }
EOF
  cat > db.js <<'EOF'
export function connect(url) { return open(url); }
export function query(sql)   { return run(sql); }
EOF
  printf 'export function format(x) { return String(x); }\n' > util.js
  git add -A; git commit -qm init >/dev/null
}

# actor | file | old | new  — six distinct functions, plus one collision (a7 vs a1 on getUser)
EDITS=(
  'a1|api.js|export function getUser(id)    { return db.find("user", id); }|export function getUser(id)    { return cache.get("user", id); }'
  'a2|api.js|export function getPost(id)    { return db.find("post", id); }|export function getPost(id)    { return cache.get("post", id); }'
  'a3|api.js|export function getComment(id) { return db.find("comment", id); }|export function getComment(id) { return cache.get("comment", id); }'
  'a4|db.js|export function connect(url) { return open(url); }|export function connect(url) { return pool.open(url); }'
  'a5|db.js|export function query(sql)   { return run(sql); }|export function query(sql)   { return run(sql, {timeout: 5000}); }'
  'a6|util.js|export function format(x) { return String(x); }|export function format(x) { return JSON.stringify(x); }'
)
COLLIDE='a7|api.js|export function getUser(id)    { return cache.get("user", id); }|export function getUser(id)    { return LEGACY.find(id); }'
apply() { node -e 'const fs=require("fs");const[f,o,n]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8");if(s.includes(o))fs.writeFileSync(f,s.replace(o,n))' "$1" "$2" "$3"; }

echo; red "════════  WITHOUT Quilt  ·  7 agents, one checkout, plain git  ════════"
W=$(mktemp -d); seed_repo "$W"
for e in "${EDITS[@]}" "$COLLIDE"; do IFS='|' read -r a f o n <<< "$e"; apply "$f" "$o" "$n"; done
dim "each agent runs 'git commit -am' — with no coordination:"
swept=0
for e in "${EDITS[@]}" "$COLLIDE"; do
  IFS='|' read -r a f o n <<< "$e"
  if git -c user.name="$a" -c user.email="$a@x" commit -qam "$a" 2>&1 | grep -qi "nothing to commit"; then
    swept=$((swept+1))
    [ "${COMPACT:-0}" = "1" ] || echo "  $a  ·  nothing to commit — its work was swept into another agent's commit"
  else [ "${COMPACT:-0}" = "1" ] || echo "  $a  ·  committed (and absorbed everyone else's uncommitted work)"; fi
done
[ "${COMPACT:-0}" = "1" ] && echo "  1 agent committed everything in one blob; $swept agents got 'nothing to commit'"
p

echo
red "  → $(($(git rev-list --count HEAD) - 1)) commit for 7 agents. getUser: $(grep -o 'return [^;]*' <(grep getUser api.js))"
red "  → a1 wanted cache.get; a7 silently overwrote it. a1's work is GONE, nothing is attributable."
cd / >/dev/null; rm -rf "$W"

echo; grn "════════  WITH Quilt  ·  same 7 agents, same checkout  ════════"
Q=$(mktemp -d); seed_repo "$Q"; q init >/dev/null
hookedit() { # actor file old new — capture through the real Pre/Post hooks
  local a="$1" f="$2" o="$3" n="$4" j deny
  j=$(node -e 'const[f,o,n]=process.argv.slice(1);process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:f,old_string:o,new_string:n}}))' "$f" "$o" "$n")
  deny=$(printf '%s' "$j" | QUILT_ACTOR="$a" q hook-pre)
  if [ -n "$deny" ]; then
    echo "  $a  ·  $(printf '\033[33mDENIED\033[0m') — $(echo "$deny" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).hookSpecificOutput.permissionDecisionReason;console.log((r.match(/held by [^)]*\)/)||[r])[0])})')"
    return 1
  fi
  apply "$f" "$o" "$n"; printf '%s' "$j" | QUILT_ACTOR="$a" q hook-post
  [ "${COMPACT:-0}" = "1" ] || echo "  $a  ·  edited $f"
}
for e in "${EDITS[@]}"; do IFS='|' read -r a f o n <<< "$e"; hookedit "$a" "$f" "$o" "$n"; p; done
[ "${COMPACT:-0}" = "1" ] && echo "  6 agents' edits captured — each attributed to its author"
dim "a1 claims getUser (with intent); a7 then tries to change the same function:"
QUILT_ACTOR=a1 q claim "api.js#getUser" --intent "A1: move getUser to cache" >/dev/null 2>&1
IFS='|' read -r a f o n <<< "$COLLIDE"; hookedit "$a" "$f" "$o" "$n"
dim "each agent commits ONLY its own lines:"
ok=0
for e in "${EDITS[@]}"; do IFS='|' read -r a f o n <<< "$e"; QUILT_ACTOR="$a" q commit --mine -m "$a" >/dev/null 2>&1 && ok=$((ok+1)); done
git log --pretty="  %an  ·  %h  %s" | grep -v " init$" | head -6
p

echo
grn "  → $ok clean commits + 1 collision prevented, for 7 agents. getUser: $(grep -o 'return [^;]*' <(grep getUser api.js))"
grn "  → a7 was stopped at the edit. no work lost. every commit is one agent's own lines."
cd / >/dev/null; rm -rf "$Q"
echo; b "Same repo. More agents. Clean commits. That's the ceiling, lifted."
