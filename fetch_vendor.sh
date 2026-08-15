#!/usr/bin/env bash
# Downloads the vendored MediaPipe face-detection runtime into vendor/
# (gitignored). Pinned to @mediapipe/tasks-vision 1.0.1 + BlazeFace
# short-range float16 v1. Re-run to repair; safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

V=1.0.1
BASE="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${V}"

mkdir -p vendor/wasm

curl -fSL "${BASE}/vision_bundle.mjs" -o vendor/vision_bundle.mjs
for f in vision_wasm_internal vision_wasm_module_internal vision_wasm_nosimd_internal; do
  curl -fSL "${BASE}/wasm/${f}.js"   -o "vendor/wasm/${f}.js"
  curl -fSL "${BASE}/wasm/${f}.wasm" -o "vendor/wasm/${f}.wasm"
done

curl -fSL \
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite" \
  -o vendor/blaze_face_short_range.tflite

echo "vendored OK:"
du -sh vendor
