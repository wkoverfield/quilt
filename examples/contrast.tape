# Quilt contrast — static side-by-side IMAGE (not a GIF) via VHS + ImageMagick.
#
#   brew install vhs imagemagick
#   vhs examples/contrast.tape        # writes examples/contrast-without.png and -with.png
#   magick examples/contrast-without.png examples/contrast-with.png +append examples/contrast.png
#   #  (ImageMagick v6: use `convert` instead of `magick`)
#
# Same scenario both sides: codex changes rate(), claude changes tax().
#   Left  (without Quilt, plain git): codex's commit absorbs claude's work -> the
#         history shows only codex; claude committed nothing.
#   Right (with Quilt): each commits only its own -> both correctly attributed.
# The two `git log`s, side by side, are the whole point. Act 1 is real git behavior.

# VHS needs an Output and at least some visible frames; this gif is a throwaway
# (gitignored). VHS rejects absolute paths here, so keep it relative.
Output contrast-build.gif

Set Shell bash
Set FontSize 20
Set Width 760
Set Height 320
Set Padding 28

# ----- hidden: build + helpers -----
Hide
Type 'Q="$PWD/dist/cli.js"; npm run build >/dev/null 2>&1'
Enter
Sleep 3s
Type 'bump_rate(){ perl -i -pe "s/0.05/0.07/" billing.js; }; bump_tax(){ perl -i -pe "s/0.20/0.25/" billing.js; }'
Enter
Type 'seed(){ git init -q; git config user.email demo@quilt.local; git config user.name demo; git config commit.gpgsign false; printf "export function rate() {\n  return 0.05;\n}\n\nexport function tax() {\n  return 0.20;\n}\n" > billing.js; git add -A; git commit -qm init >/dev/null; }'
Enter

# ----- LEFT: without Quilt (hidden setup, shown panel) -----
Type 'codex(){ git -c user.name=codex -c user.email=codex@quilt.local "$@"; }; claude(){ git -c user.name=claude -c user.email=claude@quilt.local "$@"; }'
Enter
Type 'D1=$(mktemp -d); cd "$D1"; seed; bump_rate; bump_tax'
Enter
Type 'codex commit -am "raise rate" >/dev/null; claude commit -am "raise tax" >/dev/null 2>&1'
Enter
Sleep 2s
Show
Type 'clear; echo "  ❌  WITHOUT QUILT"; echo; git log --pretty="  %an: %s"; echo; echo "  claude committed nothing -- its work folded into codex"'
Enter
Sleep 1.5s
Screenshot examples/contrast-without.png

# ----- RIGHT: with Quilt (hidden setup, shown panel) -----
Hide
Type 'unset -f codex claude; codex(){ QUILT_ACTOR=codex node "$Q" "$@"; }; claude(){ QUILT_ACTOR=claude node "$Q" "$@"; }'
Enter
Type 'D2=$(mktemp -d); cd "$D2"; seed; node "$Q" init >/dev/null; codex start --actor codex --type agent >/dev/null; claude start --actor claude --type agent >/dev/null'
Enter
Type 'codex claim billing.js#rate >/dev/null; claude claim billing.js#tax >/dev/null; bump_rate; bump_tax'
Enter
Sleep 1s
Type 'codex commit --mine -m "raise rate" >/dev/null; claude commit --mine -m "raise tax" >/dev/null'
Enter
# let all 7 quilt (node) commands finish before the screenshot, so VHS doesn't
# exit mid-setup and skip the second Screenshot
Sleep 5s
Show
Type 'clear; echo "  ✅  WITH QUILT"; echo; git log --pretty="  %an: %s"; echo; echo "  each change attributed to the agent that made it"'
Enter
Sleep 1.5s
Screenshot examples/contrast-with.png
