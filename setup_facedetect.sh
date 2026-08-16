#!/usr/bin/env bash
# One-time setup for local anime face detection: project venv + torch (CPU)
# + anime-face-detector (MIT). Weights download from HF on first use and
# live in ~/.cache/huggingface afterwards (worker runs offline then).
#
# Default venv location: <repo>/.venv. Packaged installs (read-only app
# dir) should point KOZMOZOO_VENV somewhere writable, here AND when
# starting the server, e.g. KOZMOZOO_VENV=~/.local/share/kosmozoo/venv
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="${KOZMOZOO_VENV:-$SCRIPT_DIR/.venv}"

python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip
"$VENV/bin/pip" install torch torchvision \
  --index-url https://download.pytorch.org/whl/cpu
"$VENV/bin/pip" install anime-face-detector

# warm the weight cache (also proves the pipeline works)
"$VENV/bin/python" - <<'EOF'
import numpy as np
from anime_face_detector import create_detector
det = create_detector(device="cpu")
img = np.zeros((64, 64, 3), dtype=np.uint8)   # dummy: no face expected
det(img)
print("face detector warm")
EOF

echo "setup_facedetect OK (venv: $VENV)"
if [ "$VENV" != "$SCRIPT_DIR/.venv" ]; then
  echo "NOTE: custom venv — start the server with KOZMOZOO_VENV=$VENV"
fi
