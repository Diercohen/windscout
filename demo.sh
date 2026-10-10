#!/bin/bash
# Re-record demo.gif in iTerm2 (vhs's xterm.js can't draw flag emoji).
# Needs: macOS, iTerm2, Windscribe running and logged in, ffmpeg, gifsicle, and Screen Recording
# permission for the app you run this from. The VPN hops around while it records.
# Only the iTerm2 window is captured, so other windows on top don't end up in the GIF.
set -u
cd "$(dirname "$0")"
T=$(mktemp -d)
W=1100 H=800

cat > "$T/setup.sh" <<EOF
export PS1='\$ ' XDG_CONFIG_HOME=$T/config
alias windscout='$(command -v node) $PWD/windscout.js'
clear
EOF

WID=$(osascript -e 'tell application "iTerm"
  set w to (create window with default profile command "/bin/bash --noprofile --norc")
  return id of w
end tell')
osascript -e "tell application \"iTerm\" to set bounds of (first window whose id is $WID) to {100, 60, $((100 + W)), $((60 + H))}"
it() { osascript -e "tell application \"iTerm\" to tell current session of (first window whose id is $WID) to $1"; }
key() { it "write text \"$1\" newline NO"; sleep "${2:-0.25}"; }
ret() { it "write text (ASCII character 13) newline NO"; sleep "${1:-0.4}"; } # readline wants \r for enter
esc() { it "write text (ASCII character 27) newline NO"; sleep "${1:-0.4}"; }
sleep 1
it "write text \"source $T/setup.sh\""
sleep 1.5

# frames named by capture time, so the GIF keeps real timing
mkdir "$T/fr"; touch "$T/rec"
( while [ -f "$T/rec" ]; do
    screencapture -x -o -l "$WID" "$T/fr/$(perl -MTime::HiRes=time -e 'printf "%.3f", time').png"
  done ) &
sleep 1

for c in w i n d s c o u t; do key "$c" 0.07; done
sleep 0.4; ret 2.5
key "/"; for c in n e t h e r l; do key "$c" 0.09; done
sleep 0.5; ret; key " "; esc
key "/"; for c in u n i t e d " " s t; do key "$c" 0.09; done
sleep 0.5; ret; key " "; esc 0.8
key "4" 0.5; key "5" 1 # drop wstunnel and udp to keep the scan short
ret 1

for _ in $(seq 1 300); do # wait for the final report, max 5 min
  it "get contents" | grep -q "Best (" && break
  sleep 1
done
sleep 5
rm -f "$T/rec"; wait
osascript -e "tell application \"iTerm\" to close (first window whose id is $WID)"

# picker and final report in real time, the scan in between at 3x
(cd "$T/fr" && python3 - <<'EOF'
import os
fs = sorted((f for f in os.listdir(".") if f.endswith(".png")), key=lambda f: float(f[:-4]))
ts = [float(f[:-4]) for f in fs]
out = []
for i, f in enumerate(fs):
    d = (ts[i + 1] if i + 1 < len(fs) else ts[i] + 3) - ts[i]
    if 14 < ts[i] - ts[0] < ts[-1] - ts[0] - 6:
        d /= 3
    out.append(f"file '{f}'\nduration {d:.3f}")
open("list.txt", "w").write("\n".join(out + [f"file '{fs[-1]}'"]) + "\n")
EOF
)
ffmpeg -v error -y -f concat -safe 0 -i "$T/fr/list.txt" -vf "fps=8,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$T/raw.gif"
gifsicle -O3 "$T/raw.gif" -o demo.gif
rm -rf "$T"
ls -la demo.gif
