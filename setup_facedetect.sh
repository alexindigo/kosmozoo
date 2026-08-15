#!/usr/bin/env bash
# One-time setup for local anime face detection: project venv + torch (CPU)
# + anime-face-detector (MIT). Weights download from HF on first use and
# live in ~/.cache/huggingface afterwards (worker runs offline then).
set -euo pipefail
cd "$(dirname "$0")"

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install torch torchvision \
  --index-url https://download.pytorch.org/whl/cpu
.venv/bin/pip install anime-face-detector

# warm the weight cache (also proves the pipeline works)
.venv/bin/python - <<'EOF'
import numpy as np
from anime_face_detector import create_detector
det = create_detector(device="cpu")
img = np.zeros((64, 64, 3), dtype=np.uint8)   # dummy: no face expected
det(img)
print("face detector warm")
EOF

echo "setup_facedetect OK"
