# tests/ab/extract-python.py — A/B adapter for the outgoing Python engine.
#
# Runs the frozen implementation's extract_meta() over every fixture PNG's
# embedded prompt graph and prints a canonical JSON map: filename -> meta.
# Canonicalisation (sorted keys, default-valued fields omitted) is what makes
# the byte-identical comparison against the Deno engine meaningful.
#
# Run from the FROZEN checkout (~/Projects/kosmozoo), where server.py lives:
#   python3 tests/ab/extract-python.py /path/to/fixtures
#
# The dev-branch copy of this file is identical; it is kept here so the A/B
# rig (tests/ab/compare.mjs) can invoke it against either checkout.

import json
import os
import struct
import sys
import zlib

# --- minimal PNG tEXt reader (mirrors server.py's parser) -------------------
# Stops at first IDAT, caps scan at 256 KB.

def read_png_text(path):
    out = {}
    with open(path, "rb") as f:
        buf = f.read(256 * 1024)
    if buf[:8] != b"\x89PNG\r\n\x1a\n":
        return out
    off = 8
    while off + 12 <= len(buf):
        (length,) = struct.unpack_from(">I", buf, off)
        ctype = buf[off + 4 : off + 8]
        if ctype == b"IDAT":
            break
        if ctype == b"tEXt":
            data = buf[off + 8 : off + 8 + length]
            nul = data.find(b"\x00")
            if nul > 0:
                key = data[:nul].decode("latin-1")
                val = data[nul + 1 :].decode("utf-8", "replace")
                out[key] = val
        off += 12 + length
    return out


def main():
    fixture_dir = sys.argv[1]
    sys.path.insert(0, os.getcwd())  # import server.py from the frozen checkout
    import server  # noqa: E402

    result = {}
    for name in sorted(os.listdir(fixture_dir)):
        if not name.endswith(".png"):
            continue
        text = read_png_text(os.path.join(fixture_dir, name))
        if "prompt" not in text:
            result[name] = {"nopng": True}
            continue
        try:
            graph = json.loads(text["prompt"])
        except json.JSONDecodeError:
            result[name] = {"nopng": True}
            continue
        # extract_meta expects a history entry; wrap the graph in one.
        entry = {"prompt": [2, "ab", graph]}
        meta = server.extract_meta(entry)
        result[name] = meta
    print(json.dumps(result, sort_keys=True, ensure_ascii=False))


if __name__ == "__main__":
    main()
