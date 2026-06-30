# Quilt contrast — RIGHT half of the split-screen GIF (with Quilt).
#
# Build the side-by-side, simultaneous split-screen GIF:
#   brew install vhs ffmpeg
#   vhs examples/contrast-without.tape    # writes examples/contrast-without.gif
#   vhs examples/contrast-with.tape       # writes examples/contrast-with.gif
#   ffmpeg -i examples/contrast-without.gif -i examples/contrast-with.gif \
#     -filter_complex "[0:v][1:v]hstack=inputs=2,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
#     -y examples/contrast.gif
#
# Same scenario and the same two commit commands as the left half — but each
# agent claimed its function (off-screen), so both commits land and the log shows
# both, correctly attributed. Keep Set + Sleep values identical to the left half.

Output examples/contrast-with.gif

Set Shell bash
Set Width 720
Set Height 460
Set FontSize 17
Set Padding 22
Set TypingSpeed 45ms

Hide
Type 'Q="$PWD/dist/cli.js"; npm run build >/dev/null 2>&1'
Enter
Sleep 3s
Type 'CAP="  both changes kept, attributed to who made them"'
Enter
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
Type 'perl -i -pe "s/0.05/0.07/" billing.js; perl -i -pe "s/0.20/0.25/" billing.js; clear'
Enter
Sleep 1.5s
Show
Type "#  ✅  WITH QUILT"
Enter
Sleep 1.5s
Type 'codex commit --mine -m "raise rate"'
Enter
Sleep 2s
Type 'claude commit --mine -m "raise tax"'
Enter
Sleep 2.8s
Type 'git log --pretty="  %an: %s"; echo; echo "$CAP"'
Enter
Sleep 3.8s
