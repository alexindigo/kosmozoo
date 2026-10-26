#!/usr/bin/env python3
"""Generate tiny media-reader fixtures in the project VM, never at runtime.

Requires ffmpeg + Pillow. Run from the tree: python tests/make-media-fixtures.py.
"""
import json
import subprocess
from pathlib import Path
from PIL import Image
from PIL.PngImagePlugin import PngInfo

DEST = Path(__file__).parent / "fixtures" / "media"
DEST.mkdir(exist_ok=True)
graph = {
    "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "A moving cosmic zoo"}},
    "2": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": 8, "cfg": 3.5, "positive": ["1", 0]}},
    "92": {"class_type": "SaveVideo", "inputs": {"filename_prefix": "video/fixture", "video": ["2", 0]}},
}
workflow = {"nodes": [{"id": 92, "type": "SaveVideo"}], "version": 0.4}
lineage = {"source": "fake:original.png", "seed": 41}
tags = {"prompt": graph, "workflow": workflow, "kz": lineage}
metadata = [arg for key, value in tags.items() for arg in ("-metadata", key + "=" + json.dumps(value))]

def ffmpeg(name, options, tags_args=metadata):
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=12:duration=3",
                    "-an", "-threads", "2", *options, *tags_args, str(DEST / name)], check=True, timeout=60)

ffmpeg("workflow.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "use_metadata_tags"])
ffmpeg("workflow.mov", ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "use_metadata_tags+faststart"])
ffmpeg("workflow.webm", ["-c:v", "libvpx-vp9", "-b:v", "40k"])
ffmpeg("comment.mp4", ["-c:v", "libx264"], ["-metadata", "comment=" + json.dumps(tags)])
ffmpeg("comment.webm", ["-c:v", "libvpx-vp9", "-b:v", "40k"], ["-metadata", "comment=" + json.dumps(tags)])

frames = [Image.new("RGB", (160, 96), color) for color in ("#7060b0", "#50b090")]
exif = Image.Exif()
exif[0x0110] = "prompt:" + json.dumps(graph)
for index, key in enumerate(("workflow", "kz")):
    exif[0x010F - index] = key + ":" + json.dumps(tags[key])
frames[0].save(DEST / "workflow.webp", save_all=True, append_images=frames[1:], duration=250, exif=exif, lossless=True)
png = PngInfo()
for key, value in tags.items():
    png.add_text(key, json.dumps(value))
frames[0].save(DEST / "workflow.png", pnginfo=png)
apng = PngInfo()
for key, value in tags.items():
    apng.add(b"comf", key.encode() + b"\0" + json.dumps(value).encode(), after_idat=True)
frames[0].save(DEST / "animated.png", save_all=True, append_images=frames[1:], duration=250, pnginfo=apng)
for file in sorted(DEST.iterdir()):
    assert file.stat().st_size < 100_000, file
    print(file.name, file.stat().st_size)
