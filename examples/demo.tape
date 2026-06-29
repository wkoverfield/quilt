# Quilt demo — terminal GIF script for VHS (https://github.com/charmbracelet/vhs).
#
#   brew install vhs           # one-time
#   vhs examples/demo.tape     # run from the REPO ROOT -> writes examples/demo.gif
#
# Tweak the Set lines (size/theme) and the Sleep durations to taste, then re-run.
# Two coding agents share one checkout: they claim different functions in the
# same file without contending, one gets a heads-up that something it depends on
# is changing, and each commits only its own work as a clean, attributed commit.

Output examples/demo.gif

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 760
Set Padding 24
Set TypingSpeed 55ms
# Set Theme "Dracula"   # uncomment for a theme; default is a dark scheme

# --- hidden setup: build, seed a throwaway repo, define two "agent" helpers ---
Hide
Type 'Q="$PWD/dist/cli.js"; npm run build >/dev/null 2>&1'
Enter
Type 'quilt(){ node "$Q" "$@"; }; codex(){ QUILT_ACTOR=codex node "$Q" "$@"; }; claude(){ QUILT_ACTOR=claude node "$Q" "$@"; }'
Enter
Type 'D=$(mktemp -d); cd "$D"; git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false'
Enter
Type 'printf "export function rate() {\n  return 0.05;\n}\n\nexport function total(amount) {\n  return amount * rate();\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null'
Enter
Type 'quilt init >/dev/null; codex start --actor codex --type agent >/dev/null; claude start --actor claude --type agent >/dev/null; clear'
Enter
Sleep 500ms
Show

# --- the story ---
Type '# two coding agents, one git checkout'
Enter
Sleep 1.2s
Type '# they claim different functions in the same file -- no contention:'
Enter
Sleep 1.5s
Type 'codex claim billing.js#rate'
Enter
Sleep 1.8s
Type 'claude claim billing.js#total'
Enter
Sleep 3s
Type '# ^ claude got a heads-up: total depends on rate, which codex is changing'
Enter
Sleep 2.5s

# each edits only its own function (done off-screen to keep the GIF tight)
Hide
Type 'perl -i -pe "s/0.05;/0.07;/" billing.js'
Enter
Type 'perl -i -pe "s/rate\(\);/rate() + fee();/" billing.js'
Enter
Show

Type '# each commits ONLY its own function:'
Enter
Sleep 1.2s
Type 'codex commit --mine -m "raise rate to 0.07"'
Enter
Sleep 2.5s
Type 'claude commit --mine -m "add fee to total"'
Enter
Sleep 2.5s
Type '# two clean commits, each attributed to the agent that made it:'
Enter
Sleep 1.2s
Type 'git log --pretty="  %h  %an: %s" -2'
Enter
Sleep 3.5s
