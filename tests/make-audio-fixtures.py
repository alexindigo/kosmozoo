#!/usr/bin/env python3
"""Generate tiny ComfyUI-shaped audio fixtures with ffmpeg, inside the VM."""
import json
import subprocess
from pathlib import Path

dest = Path(__file__).parent / "fixtures" / "media"
graph = {
    "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "A singing cosmic zoo"}},
    "2": {"class_type": "KSampler", "inputs": {"seed": 42, "steps": 8, "cfg": 3.5, "positive": ["1", 0]}},
    "92": {"class_type": "SaveAudio", "inputs": {"filename_prefix": "audio/fixture", "audio": ["2", 0]}},
}
tags = {"prompt": graph, "workflow": {"nodes": [{"id": 92, "type": "SaveAudio"}], "version": 0.4},
        "kz": {"source": "fake:original.png", "seed": 41}}
metadata = [arg for key, value in tags.items() for arg in ("-metadata", key + "=" + json.dumps(value))]
for ext, options in {"flac": ["-c:a", "flac"], "mp3": ["-c:a", "libmp3lame", "-b:a", "32k"],
                     "opus": ["-c:a", "libopus", "-b:a", "16k"], "wav": ["-c:a", "pcm_s16le"]}.items():
    # RIFF INFO has a fixed vocabulary: ffmpeg drops arbitrary dictionary keys.
    # ICMT retains the same prompt/workflow/kz envelope used by video comments.
    extra = ["-metadata", "comment=" + json.dumps(tags)] if ext == "wav" else []
    file = dest / ("workflow." + ext)
    subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                    "sine=frequency=440:sample_rate=8000:duration=3", "-threads", "2", *options, *metadata, *extra, str(file)],
                   check=True, timeout=60)
    assert file.stat().st_size < 100_000
    print(file.name, file.stat().st_size, flush=True)
    subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags:stream_tags", "-of", "json", str(file)],
                   check=True, timeout=30)
