#!/bin/bash
# Convert WebM (Playwright output) → MP4 with H.264 + faststart for web.
# Outputs go to ../assets/videos/

set -euo pipefail
cd "$(dirname "$0")"

mkdir -p ../assets/videos

for name in feature-1-capture feature-2-ai-why feature-3-multichannel feature-4-journey; do
  src="recordings/${name}.webm"
  dst="../assets/videos/${name}.mp4"
  if [ ! -f "$src" ]; then
    echo "✗ Missing $src — skipping"
    continue
  fi
  echo "→ ${src} → ${dst}"
  ffmpeg -y -i "$src" \
    -c:v libx264 -preset slow -crf 23 \
    -movflags +faststart \
    -an \
    -loglevel error \
    "$dst"
  ls -lh "$dst" | awk '{print "  ✓ " $9 " (" $5 ")"}'
done

echo ""
echo "Done. Videos ready in assets/videos/"
