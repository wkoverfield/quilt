# Quilt contrast — LEFT half of the split-screen GIF (without Quilt).
# See examples/contrast-with.tape for the right half and the stack step.
#
#   vhs examples/contrast-without.tape    # writes examples/contrast-without.gif
#
# Real naive-git behavior: codex changes rate(), claude changes tax(); the same
# two commit commands run on both sides — here codex's commit absorbs claude's
# work, claude gets "nothing to commit", and the log shows only codex.
#
# Keep the Set + Sleep values identical to contrast-with.tape so the two halves
# stay the same size and stay in sync when stacked.

Output examples/contrast-without.gif

Set Shell bash
Set Width 720
Set Height 460
Set FontSize 17
Set Padding 22
Set TypingSpeed 45ms

Hide
Type 'CAP="  claude lost its work, absorbed by codex"'
Enter
Type 'codex(){ git -c user.name=codex -c user.email=codex@quilt.local "$@"; }; claude(){ git -c user.name=claude -c user.email=claude@quilt.local "$@"; }'
Enter
Type 'D=$(mktemp -d); cd "$D"; git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false'
Enter
Type 'printf "export function rate() {\n  return 0.05;\n}\n\nexport function tax() {\n  return 0.20;\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null'
Enter
Type 'perl -i -pe "s/0.05/0.07/" billing.js; perl -i -pe "s/0.20/0.25/" billing.js; clear'
Enter
Show
Type "#  ❌  WITHOUT QUILT"
Enter
Sleep 1.5s
Type 'codex commit -am "raise rate"'
Enter
Sleep 2s
Type 'claude commit -am "raise tax"'
Enter
Sleep 2.8s
Type 'git log --pretty="  %an: %s"; echo; echo "$CAP"'
Enter
Sleep 3.8s
