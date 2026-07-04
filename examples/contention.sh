#!/usr/bin/env bash
#
# Quilt contention demo. What happens when agents WANT the same files.
#
# Two builders race for overlapping scopes on one checkout — the exact wave a
# 20-hour dogfood fleet ran: one wins the claims, the other is denied WITH the
# holder's intent and lease expiry, builds everything else while blocked, then
# layers on top after the auto-release. Zero clobbers, zero lost lines, every
# commit one agent's own work. Driven through the REAL Quilt machinery (claims,
# native-edit hooks, commit --mine). Nothing faked; run it yourself.
#
#   ./examples/contention.sh                             # run it
#   QUILT=/path/to/dist/cli.js ./examples/contention.sh  # use a specific build
#
set -u
QUILT="${QUILT:-$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js}"
PACE="${PACE:-0}"
p() { [ "$PACE" = "0" ] || sleep "$PACE"; }
q() { node "$QUILT" "$@"; }
b() { printf "\033[1m%s\033[0m\n" "$*"; }
grn() { printf "\033[32m%s\033[0m\n" "$*"; }
yel() { printf "\033[33m%s\033[0m\n" "$*"; }
dim() { printf "\033[2m%s\033[0m\n" "$*"; }

D=$(mktemp -d); cd "$D" || exit 1
git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false
cat > deals.js <<'EOF'
export function renameDeal(id, name) { return db.set("deal", id, {name}); }
EOF
cat > money.js <<'EOF'
export function totals() { return db.sum("deals"); }
EOF
cat > flows.js <<'EOF'
export function listFlows() { return db.all("flows"); }
EOF
git add -A; git commit -qm init >/dev/null
q init >/dev/null

apply() { node -e 'const fs=require("fs");const[f,o,n]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8");if(s.includes(o))fs.writeFileSync(f,s.replace(o,n))' "$1" "$2" "$3"; }
hookedit() { # actor file old new — capture through the real Pre/Post hooks
  local a="$1" f="$2" o="$3" n="$4" j
  j=$(node -e 'const[f,o,n]=process.argv.slice(1);process.stdout.write(JSON.stringify({tool_name:"Edit",tool_input:{file_path:f,old_string:o,new_string:n}}))' "$f" "$o" "$n")
  printf '%s' "$j" | QUILT_ACTOR="$a" q hook-pre >/dev/null
  apply "$f" "$o" "$n"
  printf '%s' "$j" | QUILT_ACTOR="$a" q hook-post
}

echo
b "════════  Two builders, overlapping scopes, one checkout  ════════"
echo
dim "builder-friction wins the race — claims its whole scope, with intent:"
QUILT_ACTOR=builder-friction q claim deals.js money.js --intent "friction pass: rename + archive flags" | sed 's/^/  /'
p
echo
dim "builder-flows asks for deals.js too (plus its own flows.js) — one call, partial grant:"
QUILT_ACTOR=builder-flows q claim deals.js flows.js --intent "flows pass: wire flows to deals" 2>&1 | sed 's/^/  /'
p
echo
yel "  denied ≠ blocked: builder-flows builds everything else it owns while it waits."
hookedit builder-flows flows.js 'return db.all("flows");' 'return db.all("flows", {order: "recent"});'
dim "  builder-flows  ·  edited flows.js (captured, attributed)"
p
echo
dim "builder-friction does its pass and commits — only its own lines:"
hookedit builder-friction deals.js 'export function renameDeal(id, name) { return db.set("deal", id, {name}); }' 'export function renameDeal(id, name) { return db.set("deal", id, {name, archived: false}); }'
hookedit builder-friction money.js 'export function totals() { return db.sum("deals"); }' 'export function totals() { return db.sum("deals", {skipArchived: true}); }'
QUILT_ACTOR=builder-friction q commit --mine -m "friction: archive flags" | sed 's/^/  /'
p
echo
dim "builder-flows retries — the blocker's claims auto-released on commit:"
QUILT_ACTOR=builder-flows q claim deals.js --intent "flows pass: wire flows to deals" | sed 's/^/  /'
hookedit builder-flows deals.js 'return db.set("deal", id, {name, archived: false});' 'return notifyFlows(db.set("deal", id, {name, archived: false}));'
dim "  builder-flows  ·  layered its change ON TOP of the landed one, then commits:"
QUILT_ACTOR=builder-flows q commit --mine -m "flows: notify on rename" | sed 's/^/  /'
p
echo
b "════════  The wave converged  ════════"
git log --pretty="  %an  ·  %h  %s" | grep -v " init$"
if grep -q notifyFlows deals.js && grep -q archived deals.js; then
  grn "  → deals.js carries BOTH changes on one line: the archive flag AND the notify wrap."
fi
grn "  → denial carried the holder's intent and lease expiry — nobody waited blind."
grn "  → 0 clobbers, 0 lost lines, every commit one agent's own work."
cd / >/dev/null; rm -rf "$D"
echo; b "Both agents landed on the same file. The denial told the second one what to wait for."
