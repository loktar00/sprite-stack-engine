#!/bin/sh
# encode.sh: capture the camera tour and make an MP4 and a small GIF, then a small GIF of each slice effect.   sh tools/encode.sh
# Needs python with Playwright (see capture.py) and ffmpeg. Output goes to out/.
set -e
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
mkdir -p out
# 1920x1080 (the film is made at native resolution: res=native), 30 frames a second (every second step of the 60-a-second clock), 22 seconds
$PY tools/capture.py out/tour --size 1920x1080 --step 2 --query "&tour&hud=1.8&res=native"
ffmpeg -v error -y -framerate 30 -i out/tour/%04d.png -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart out/tour.mp4
# the GIF: 400 pixels wide, 10 frames a second, its palette made from the frames
ffmpeg -v error -y -framerate 30 -i out/tour/%04d.png -vf "fps=10,scale=400:-1:flags=area,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 out/tour.gif
# the slice effects: four seconds each, 15 frames a second, 400 pixels wide
for fx in build dismantle lower; do
  $PY tools/capture.py out/fx-$fx --size 800x450 --step 4 --query "&fx=$fx&nohud&tod=0.35&res=native"
  ffmpeg -v error -y -framerate 15 -i out/fx-$fx/%04d.png -vf "scale=400:-1:flags=area,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 out/fx-$fx.gif
done
ls -l out/tour.mp4 out/tour.gif out/fx-*.gif
