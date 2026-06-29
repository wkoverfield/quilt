# Quilt contrast — LEFT panel (without Quilt). One screenshot, via VHS.
# See examples/contrast-with.tape for the right panel and the compose step.
#
#   vhs examples/contrast-without.tape   # writes examples/contrast-without.png
#
# Real naive-git behavior: codex changes rate(), claude changes tax(); codex's
# commit absorbs both, so the history shows only codex and claude committed nothing.

Output contrast-build.gif

Set Shell bash
Set FontSize 20
Set Width 760
Set Height 320
Set Padding 28

Hide
Type 'codex(){ git -c user.name=codex -c user.email=codex@quilt.local "$@"; }; claude(){ git -c user.name=claude -c user.email=claude@quilt.local "$@"; }'
Enter
Type 'D=$(mktemp -d); cd "$D"; git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false'
Enter
Type 'printf "export function rate() {\n  return 0.05;\n}\n\nexport function tax() {\n  return 0.20;\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null'
Enter
Type 'perl -i -pe "s/0.05/0.07/" billing.js; perl -i -pe "s/0.20/0.25/" billing.js'
Enter
Type 'codex commit -am "raise rate" >/dev/null; claude commit -am "raise tax" >/dev/null 2>&1'
Enter
Sleep 1.5s
Show
Type 'clear; echo "  ❌  WITHOUT QUILT"; echo; git log --pretty="  %an: %s"; echo; echo "  claude committed nothing -- its work folded into codex"'
Enter
Sleep 1.5s
Screenshot examples/contrast-without.png
Sleep 1s
