#!/bin/sh
# Nutcache walkthrough video: intro card + bury recording + card + dig recording + outro, with captions -> public/walkthrough.mp4
# Inputs: the webm recordings from tools/demo-video.mjs (run it against the live site so the link shows the real URL).
set -e
cd "$(dirname "$0")"
R=$(cd ../.. && pwd)
A=$(ls -t $R/shots/video/bury/*.webm | head -1)
B=$(ls -t $R/shots/video/dig/*.webm | head -1)
F=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
FB=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
W=1100; H=760; CH=96
rm -rf t; mkdir -p t
cap() { printf '%s' "$2" > t/$1.txt; }
# A: bury (21.4 s)
cap a1 "Nutcache: bury Cashu ecash behind a riddle. This is the test mint: the Lightning is fake and the sats are not real."
cap a2 "Write a riddle and its answer. The page locks the sats to the hash of scrypt(answer): a NUT-14 hashlock at the mint."
cap a3 "Add a stage and it becomes a hunt: stage 2 is encrypted with a key that only the right answer to stage 1 can derive."
cap a4 "Buried. The whole cache travels in the link and on the printable card. There is no server."
# B: dig (24.7 s)
cap b1 "Someone else opens the link. The mint (NUT-07) says the proofs are still unspent."
cap b2 "A wrong guess is checked offline, in the browser: the mint never sees it."
cap b3 "The right answer (case and punctuation don't matter) becomes the HTLC witness: the mint swaps the sats to the digger. Stage 2 unlocks."
cap b4 "Stage 2 could not even be read before. Dig it too."
cap b5 "Open the link again: dug up. The witness the mint stored proves it was solved, not taken back."
dt() { echo "drawtext=fontfile=$F:textfile=t/$1.txt:fontcolor=white:fontsize=21:line_spacing=6:x=28:y=$H+18:enable='between(t,$2,$3)'"; }
wrap() { fold -s -w 92 t/$1.txt > t/$1.w && mv t/$1.w t/$1.txt; }
for c in a1 a2 a3 a4 b1 b2 b3 b4 b5; do wrap $c; done
base="scale=$W:$H,pad=$W:$H+$CH:0:0:color=0x3b2416,fps=25,format=yuv420p"
ffmpeg -v error -y -i "$A" -vf "$base,$(dt a1 0 6.1),$(dt a2 6.1 12.4),$(dt a3 12.4 17.6),$(dt a4 17.6 22)" -an -c:v libx264 -crf 26 -preset slow t/A.mp4
ffmpeg -v error -y -i "$B" -vf "$base,$(dt b1 0 3.3),$(dt b2 3.3 6.8),$(dt b3 6.8 15.3),$(dt b4 15.3 19.7),$(dt b5 19.7 25)" -an -c:v libx264 -crf 26 -preset slow t/B.mp4
card() { # name seconds title line1 line2
  printf '%s' "$3" > t/$1_t.txt; printf '%s' "$4" > t/$1_1.txt; printf '%s' "$5" > t/$1_2.txt
  ffmpeg -v error -y -f lavfi -i "color=c=0xfbf4e6:s=${W}x$((H+CH)):d=$2:r=25" -vf "drawtext=fontfile=$FB:textfile=t/$1_t.txt:fontcolor=0x3b2416:fontsize=64:x=(w-tw)/2:y=h/2-110,drawtext=fontfile=$F:textfile=t/$1_1.txt:fontcolor=0x8a4b1c:fontsize=28:x=(w-tw)/2:y=h/2+0,drawtext=fontfile=$F:textfile=t/$1_2.txt:fontcolor=0x5a4636:fontsize=24:x=(w-tw)/2:y=h/2+60,format=yuv420p" -c:v libx264 -crf 26 t/$1.mp4
}
card intro 3.5 "Nutcache" "Bury sats behind a riddle" "Cashu NUT-14 hashlocks  ·  hunts with sealed stages  ·  #NutNovember"
card mid 2.5 "Dig" "Anyone with the link can try" "Only the right answer opens it: not the burier, not this page"
card outro 4.5 "Try it" "mmajjd926-netizen.github.io/nutcache" "Open source (MIT): github.com/mmajjd926-netizen/nutcache"
printf "file 'intro.mp4'\nfile 'A.mp4'\nfile 'mid.mp4'\nfile 'B.mp4'\nfile 'outro.mp4'\n" > t/list.txt
ffmpeg -v error -y -f concat -safe 0 -i t/list.txt -c:v libx264 -crf 27 -preset slow -movflags +faststart -pix_fmt yuv420p $R/public/walkthrough.mp4
ffmpeg -v error -y -ss 39 -i $R/public/walkthrough.mp4 -frames:v 1 -q:v 4 $R/docs/walkthrough.jpg
rm -rf t
ls -la $R/public/walkthrough.mp4 $R/docs/walkthrough.jpg
