# Quilt contrast demo — terminal GIF script for VHS (https://github.com/charmbracelet/vhs).
#
#   brew install vhs               # one-time
#   vhs examples/demo-contrast.tape   # run from REPO ROOT -> writes examples/demo-contrast.gif
#
# Two acts, same scenario: codex changes rate(), claude changes tax() in one file.
#   Act 1 WITHOUT Quilt (plain git): codex's commit absorbs claude's work; claude
#     gets "nothing to commit" and the history credits codex for everything.
#   Act 2 WITH Quilt: each claims its function, commits only its own, and both
#     land correctly attributed.
# The same `git log` is shown at the end of each act — wrong, then right.
#
# Act 1 is real naive-git behavior, not a staged failure. Tweak Sleep/Set to taste.

Output examples/demo-contrast.gif

Set Shell bash
Set FontSize 18
Set Width 1200
Set Height 800
Set Padding 24
Set TypingSpeed 50ms

# ---------- shared build ----------
Hide
Type 'Q="$PWD/dist/cli.js"; npm run build >/dev/null 2>&1; clear'
Enter

# ========== ACT 1 — WITHOUT QUILT ==========
# hidden: two agents = git with their identity; seed repo; apply BOTH edits
Type 'codex(){ git -c user.name=codex -c user.email=codex@quilt.local "$@"; }; claude(){ git -c user.name=claude -c user.email=claude@quilt.local "$@"; }'
Enter
Type 'D1=$(mktemp -d); cd "$D1"; git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false'
Enter
Type 'printf "export function rate() {\n  return 0.05;\n}\n\nexport function tax() {\n  return 0.07;\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null'
Enter
Type 'perl -i -pe "s/0.05;/0.07;/" billing.js'
Enter
Type 'perl -0pi -e "s/(tax\(\) \{\n  return )0.07;/\${1}0.09;/" billing.js'
Enter
Type 'clear'
Enter
Show
Type 'echo; echo "  ❌  WITHOUT QUILT   two agents, one checkout, plain git"; echo'
Enter
Sleep 1.8s
Type "# codex changed rate(), claude changed tax() -- two different functions"
Enter
Sleep 1.6s
Type 'codex commit -am "raise rate"'
Enter
Sleep 2s
Type "# now claude commits its own work..."
Enter
Sleep 1.4s
Type 'claude commit -am "raise tax"'
Enter
Sleep 2.8s
Type "# claude's change was swallowed into codex's commit -- wrong author, nothing of its own"
Enter
Sleep 2.4s
Type 'git log --pretty="  %an: %s"'
Enter
Sleep 3.4s

# ========== ACT 2 — WITH QUILT ==========
Hide
Type 'unset -f codex claude; codex(){ QUILT_ACTOR=codex node "$Q" "$@"; }; claude(){ QUILT_ACTOR=claude node "$Q" "$@"; }'
Enter
Type 'D2=$(mktemp -d); cd "$D2"; git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false'
Enter
Type 'printf "export function rate() {\n  return 0.05;\n}\n\nexport function tax() {\n  return 0.07;\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null'
Enter
Type 'node "$Q" init >/dev/null; codex start --actor codex --type agent >/dev/null; claude start --actor claude --type agent >/dev/null; clear'
Enter
Show
Type 'echo; echo "  ✅  WITH QUILT   same edits, same checkout"; echo'
Enter
Sleep 1.8s
Type "# each agent claims the function it is about to change:"
Enter
Sleep 1.5s
Type 'codex claim billing.js#rate'
Enter
Sleep 1.6s
Type 'claude claim billing.js#tax'
Enter
Sleep 2s
Hide
Type 'perl -i -pe "s/0.05;/0.07;/" billing.js; perl -0pi -e "s/(tax\(\) \{\n  return )0.07;/\${1}0.09;/" billing.js'
Enter
Show
Type "# each commits ONLY its own function:"
Enter
Sleep 1.4s
Type 'codex commit --mine -m "raise rate"'
Enter
Sleep 2s
Type 'claude commit --mine -m "raise tax"'
Enter
Sleep 2.2s
Type "# both landed, each attributed to the agent that did the work:"
Enter
Sleep 1.5s
Type 'git log --pretty="  %an: %s"'
Enter
Sleep 4s
