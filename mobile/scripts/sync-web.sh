#!/usr/bin/env bash
# Fill mobile/www (Capacitor webDir) from ../public: the whole web app runs on the device,
# network calls go to https://rukh.mmix.biz through public/js/env.js.
# Left out: demo videos and anything heavy the app never loads.
# In the app the start page is app.html (copied to index.html); pages are reached as /cam.html, /screen.html, ...
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=../public
rm -rf www && mkdir -p www
rsync -a --delete \
  --exclude 'demo/' \
  --exclude '*.map' \
  --exclude '.DS_Store' \
  "$SRC/" www/
cp www/app.html www/index.html
# native glue (keep-awake, back button, clean-path links) goes into every bundled page, after <head>
cp web/native.js www/js/native.js
for f in www/*.html; do
  grep -q '/js/native.js' "$f" || sed -i 's|<head>|<head>\n<script src="/js/native.js"></script>|' "$f"
done
# wasm with SIMD only (all supported WebViews have it); drop the non-SIMD build if it ever gets vendored
rm -f www/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.* 2>/dev/null || true
echo "www: $(du -sh www | cut -f1), $(find www -type f | wc -l) files"
