# Quilt contrast — RIGHT panel (with Quilt). One screenshot, via VHS.
#
# Generate BOTH panels and compose the side-by-side image:
#   brew install vhs imagemagick
#   vhs examples/contrast-without.tape    # writes examples/contrast-without.png
#   vhs examples/contrast-with.tape       # writes examples/contrast-with.png
#   magick examples/contrast-without.png examples/contrast-with.png +append examples/contrast.png
#   #  (ImageMagick v6: use `convert` instead of `magick`)
#
# Same scenario as the left panel, but each agent claims its function and commits
# only its own, so both land correctly attributed.

Output contrast-build.gif

Set Shell bash
Set FontSize 20
Set Width 760
Set Height 320
Set Padding 28

Hide
Type 'Q="$PWD/dist/cli.js"; npm run build >/dev/null 2>&1'
Enter
Sleep 3s
Type 'codex(){ QUILT_ACTOR=codex node "$Q" "$@"; }; claude(){ QUILT_ACTOR=claude node "$Q" "$@"; }'
Enter
Type 'D=$(mktemp -d); cd "$D"; git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false'
Enter
Type 'printf "export function rate() {\n  return 0.05;\n}\n\nexport function tax() {\n  return 0.20;\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null'
Enter
Type 'node "$Q" init >/dev/null; codex start --actor codex --type agent >/dev/null; claude start --actor claude --type agent >/dev/null'
Enter
Sleep 2s
Type 'codex claim billing.js#rate >/dev/null; claude claim billing.js#tax >/dev/null'
Enter
Sleep 1.5s
Type 'perl -i -pe "s/0.05/0.07/" billing.js; perl -i -pe "s/0.20/0.25/" billing.js'
Enter
Type 'codex commit --mine -m "raise rate" >/dev/null; claude commit --mine -m "raise tax" >/dev/null'
Enter
Sleep 3s
Show
Type 'clear; echo "  ✅  WITH QUILT"; echo; git log --pretty="  %an: %s"; echo; echo "  each change attributed to the agent that made it"'
Enter
Sleep 1.5s
Screenshot examples/contrast-with.png
Sleep 1s
