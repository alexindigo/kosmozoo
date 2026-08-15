#!/usr/bin/env python3
"""Kosmozoo face-detection worker (anime-face-detector, torch CPU).

Long-lived helper spawned by server.py. Protocol: JSON Lines over
stdin/stdout — each request line is {"id": N, "b64": "<image bytes>"};
each response is {"id": N, "w": int, "h": int, "faces": [...]} or
{"id": N, "error": "..."}. Prints {"ready": true} once models are loaded.

Weights come from the HF cache (~/.cache/huggingface); when present we run
fully offline (HF_HUB_OFFLINE=1).
"""

import base64
import json
import os
import sys
from pathlib import Path

# Use the HF cache offline when weights are already downloaded.
_hf_cache = Path.home() / ".cache" / "huggingface"
if _hf_cache.exists() and any(_hf_cache.rglob("anime-face-detector*")):
    os.environ["HF_HUB_OFFLINE"] = "1"


def main():
    import cv2
    import numpy as np
    from anime_face_detector import create_detector

    det = create_detector(device="cpu")

    def detect(image_bytes):
        arr = cv2.imdecode(np.frombuffer(image_bytes, np.uint8),
                           cv2.IMREAD_COLOR)
        if arr is None:
            return {"error": "could not decode image"}
        h, w = arr.shape[:2]
        faces = []
        for r in det(arr):
            bbox = [float(v) for v in r["bbox"]]
            kps = np.asarray(r["keypoints"], dtype=float)  # (28,3): x,y,score
            faces.append({
                "bbox": bbox[:4],
                "score": bbox[4] if len(bbox) > 4 else None,
                "kps": [[float(x), float(y), float(s)] for x, y, s in kps],
            })
        return {"w": w, "h": h, "faces": faces}

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            res = detect(base64.b64decode(req["b64"]))
        except Exception as exc:  # keep the worker alive on bad input
            res = {"error": f"{type(exc).__name__}: {exc}"}
        res["id"] = req.get("id") if isinstance(req, dict) else None
        sys.stdout.write(json.dumps(res) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
