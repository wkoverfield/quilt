# Quilt motion demo — short terminal GIF for VHS (https://github.com/charmbracelet/vhs).
#
#   brew install vhs           # one-time
#   vhs examples/demo.tape     # run from REPO ROOT -> writes examples/demo.gif
#
# ~12s "watch it work": two agents claim different functions in one file, claude
# gets a heads-up that something it depends on is changing, and each commits only
# its own work. Tighten the Sleep values to make it shorter.

Output examples/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1100
Set Height 600
Set Padding 24
Set TypingSpeed 45ms

# ---------- hidden setup ----------
Hide
Type 'Q="$PWD/dist/cli.js"; npm run build >/dev/null 2>&1'
Enter
Type 'codex(){ QUILT_ACTOR=codex node "$Q" "$@"; }; claude(){ QUILT_ACTOR=claude node "$Q" "$@"; }'
Enter
Type 'bump_rate(){ perl -i -pe "s/0.05/0.07/" billing.js; }; bump_total(){ perl -i -pe "s/rate\(\);/rate() * 1.1;/" billing.js; }'
Enter
Type 'D=$(mktemp -d); cd "$D"; git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false'
Enter
Type 'printf "export function rate() {\n  return 0.05;\n}\n\nexport function total(amount) {\n  return amount * rate();\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null'
Enter
Type 'node "$Q" init >/dev/null; codex start --actor codex --type agent >/dev/null; claude start --actor claude --type agent >/dev/null; clear'
Enter
Show

# ---------- the story ----------
Type "# two agents, one checkout -- they claim different functions:"
Enter
Sleep 1.2s
Type 'codex claim billing.js#rate'
Enter
Sleep 1.4s
Type 'claude claim billing.js#total'
Enter
Sleep 2.6s
Type "# each edits its own function, then commits only that:"
Enter
Sleep 1s
Type 'bump_rate; bump_total'
Enter
Sleep 1s
Type 'codex commit --mine -m "raise rate"'
Enter
Sleep 1.8s
Type 'claude commit --mine -m "scale total"'
Enter
Sleep 1.8s
Type 'git log --pretty="  %an: %s"'
Enter
Sleep 3.2s
