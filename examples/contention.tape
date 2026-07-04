# The contention demo GIF: two builders, overlapping scopes, one checkout.
#   vhs examples/contention.tape   # writes examples/contention.gif (run from repo root)
# Keep dist/ built first: npm run build.

Output examples/contention.gif

Set Shell bash
Set Width 1000
Set Height 720
Set FontSize 13
Set Padding 24
Set TypingSpeed 35ms

Type "PACE=0.9 ./examples/contention.sh"
Enter
Sleep 16s
Sleep 2s
