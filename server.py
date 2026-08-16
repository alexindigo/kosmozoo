#!/usr/bin/env python3
"""Kosmozoo image-review server.

Python stdlib only. Serves index.html and proxies the configured ComfyUI
hosts so the page never hits CORS. Binds 127.0.0.1:8765 (no auth).

Usage: python3 review_server.py
"""

import base64
import itertools
import json
import os
import re
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- Config ---------------------------------------------------------------
# Hosts shown in the dropdown, label -> host:port of a ComfyUI server.
# Configured via config.json "hosts" or the KOZMOZOO_HOSTS env var
# ("name=host:port,name2=host2:port2"); the default is a local instance.
DEFAULT_HOSTS = {"local": "127.0.0.1:8188"}

# all overridable from the environment
BIND = os.environ.get("KOZMOZOO_BIND", "0.0.0.0")
PORT = int(os.environ.get("KOZMOZOO_PORT", "2084"))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


# Writable state directory: config.json, metadata.db, faceboxes_cache.json.
# Default is BASE_DIR (repo checkout). When BASE_DIR is read-only (packaged
# install under /usr/lib), state falls back to an XDG-style per-user dir.
# Explicit override: KOZMOZOO_STATE.
def _default_state_dir():
    if os.access(BASE_DIR, os.W_OK):
        return BASE_DIR
    return os.path.join(
        os.environ.get("XDG_STATE_HOME",
                       os.path.expanduser("~/.local/state")), "kosmozoo")


STATE_DIR = os.path.expanduser(
    os.environ.get("KOZMOZOO_STATE", _default_state_dir()))
os.makedirs(STATE_DIR, exist_ok=True)
# feedback.json is canonical curation data and lives OUTSIDE the repo.
# The path is configurable (☰ menu); persisted in config.json (gitignored).
DEFAULT_COMMENTS_PATH = os.path.expanduser(
    os.environ.get("KOZMOZOO_FEEDBACK", "~/Documents/kosmozoo_feedback.json"))
CONFIG_PATH = os.path.join(STATE_DIR, "config.json")


def _load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


_cfg = _load_config()

# curation buckets (stored per image in feedback.json entries) —
# configurable: config.json "buckets" or KOZMOZOO_BUCKETS env; the default
# is generic on purpose
DEFAULT_BUCKETS = ["good", "almost", "needs_work", "reject", "other",
                   "broken"]


def _parse_hosts_env(raw):
    out = {}
    for part in raw.split(","):
        name, _, addr = part.partition("=")
        if name.strip() and addr.strip():
            out[name.strip()] = addr.strip()
    return out


HOSTS = _cfg.get("hosts") or _parse_hosts_env(
    os.environ.get("KOZMOZOO_HOSTS", "")) or DEFAULT_HOSTS
COMMENTS_PATH = os.path.expanduser(
    _cfg.get("feedbackPath") or os.environ.get("KOZMOZOO_FEEDBACK")
    or DEFAULT_COMMENTS_PATH)
BUCKETS = _cfg.get("buckets") or [b for b in os.environ.get(
    "KOZMOZOO_BUCKETS", ",".join(DEFAULT_BUCKETS)).split(",") if b]
INDEX_HTML = os.path.join(BASE_DIR, "index.html")
DOWNLOADS_DIR = os.path.expanduser(
    os.environ.get("KOZMOZOO_DOWNLOADS", "~/Downloads"))
VENDOR_DIR = os.path.join(BASE_DIR, "vendor")
VENDOR_MIME = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".tflite": "application/octet-stream",
    ".json": "application/json",
}

# note-type tags; "character" is the default and is stored as "absent"
TAGS = ("character", "scene", "style")

# local anime face detection (detect_worker.py in the project venv)
_venv = os.environ.get("KOZMOZOO_VENV")
FACEWORKER_PY = (os.path.join(_venv, "bin", "python") if _venv
                 else os.path.join(BASE_DIR, ".venv", "bin", "python"))
DETECT_WORKER = os.path.join(BASE_DIR, "detect_worker.py")
FACEBOX_CACHE_PATH = os.path.join(STATE_DIR, "faceboxes_cache.json")

# persistent metadata store: ComfyUI /api/history is volatile (lost on the
# host's restart), and the PNG files themselves carry the executed graph in
# tEXt chunks. Both sources merge into one durable sqlite store; the legacy
# metadata_cache.json is imported once and renamed to .imported.
METADATA_DB_PATH = os.path.expanduser(
    os.environ.get("KOZMOZOO_METADATA",
                   os.path.join(STATE_DIR, "metadata.db")))
METADATA_CACHE_PATH = os.path.join(STATE_DIR, "metadata_cache.json")  # legacy

# background metadata scraper: walks the host's image list and extracts
# PNG-embedded metadata for files the store doesn't know yet. Toggleable
# from the UI; persisted in config.json ("scraperEnabled", default on).
SCRAPER_ENABLED = bool(_cfg.get("scraperEnabled", True))

STATUS_TIMEOUT = 8    # seconds, /api/hosts reachability probe
                      # (ComfyUI stalls its API while generating)
PROXY_TIMEOUT = 30    # seconds, JSON endpoints
IMAGE_TIMEOUT = 60    # seconds, image bytes

UA = {"User-Agent": "kosmozoo/1.0"}

_comments_lock = threading.Lock()


# --- comments.json I/O -----------------------------------------------------

def read_comments():
    with _comments_lock:
        try:
            with open(COMMENTS_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}


def upsert_comment(key, fields):
    """Partial update of one entry. fields may contain neg (str),
    pos (str), vote ('up'|'down'|None to clear), bucket (BUCKETS|"" to
    clear), tag (TAGS|None to clear; 'character' is default = absent).
    Entries with no remaining content are removed."""
    with _comments_lock:
        try:
            with open(COMMENTS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}
        entry = data.get(key)
        if entry is None:
            entry = {}
        elif isinstance(entry, str):      # legacy plain-string comment
            entry = {"neg": entry, "pos": ""}
        if "neg" in fields:
            entry["neg"] = fields["neg"]
        if "pos" in fields:
            entry["pos"] = fields["pos"]
        if "vote" in fields:
            if fields["vote"] in ("up", "down"):
                entry["vote"] = fields["vote"]
            else:
                entry.pop("vote", None)
        if "bucket" in fields:
            if fields["bucket"] in BUCKETS:
                entry["bucket"] = fields["bucket"]
            else:
                entry.pop("bucket", None)
        if "tag" in fields:
            if fields["tag"] in ("scene", "style"):
                entry["tag"] = fields["tag"]
            else:
                entry.pop("tag", None)   # 'character' = default = absent
        if not entry.get("neg", "").strip() \
                and not entry.get("pos", "").strip() \
                and not entry.get("vote") \
                and not entry.get("bucket") \
                and not entry.get("tag"):
            data.pop(key, None)
        else:
            data[key] = entry
        # temp file must live next to the target (os.replace can't cross
        # filesystems — the configured path may be on another mount)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(COMMENTS_PATH),
                                   suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.write("\n")
            os.replace(tmp, COMMENTS_PATH)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        return data


# --- ComfyUI proxy helpers --------------------------------------------------

def host_base(host_label):
    addr = HOSTS.get(host_label)
    return f"http://{addr}" if addr else None


def fetch_json(url, timeout):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def probe_host(addr):
    try:
        req = urllib.request.Request(
            f"http://{addr}/api/system_stats", headers=UA)
        with urllib.request.urlopen(req, timeout=STATUS_TIMEOUT) as resp:
            return resp.status == 200
    except Exception:
        return False


# --- face-detection worker --------------------------------------------------

_face_worker = None
_face_worker_lock = threading.Lock()   # worker protocol is strictly serial
_face_req_ids = itertools.count(1)
_facebox_cache = None
_facebox_cache_lock = threading.RLock()   # put() re-enters via _load()


def _face_worker_start():
    global _face_worker
    if not os.path.exists(FACEWORKER_PY):
        raise RuntimeError(
            "face detection not set up; run ./setup_facedetect.sh")
    proc = subprocess.Popen(
        [FACEWORKER_PY, DETECT_WORKER],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, cwd=BASE_DIR, text=True, bufsize=1)
    # blocks until models are loaded (first-ever run downloads weights)
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("face worker died during model load")
    if not json.loads(line).get("ready"):
        raise RuntimeError(f"face worker not ready: {line.strip()}")
    _face_worker = proc


def face_detect(image_bytes):
    """Run one detection through the persistent worker (serial)."""
    global _face_worker
    with _face_worker_lock:
        if _face_worker is None or _face_worker.poll() is not None:
            _face_worker = None
            _face_worker_start()
        req_id = next(_face_req_ids)
        _face_worker.stdin.write(json.dumps(
            {"id": req_id, "b64": base64.b64encode(image_bytes).decode()})
            + "\n")
        _face_worker.stdin.flush()
        res = json.loads(_face_worker.stdout.readline())
        if res.get("id") != req_id:
            raise RuntimeError("face worker protocol desync")
        if "error" in res:
            raise RuntimeError(res["error"])
        return res


def _facebox_cache_load():
    global _facebox_cache
    with _facebox_cache_lock:
        if _facebox_cache is None:
            try:
                with open(FACEBOX_CACHE_PATH, encoding="utf-8") as f:
                    _facebox_cache = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                _facebox_cache = {}
        return _facebox_cache


def _facebox_cache_put(key, value):
    with _facebox_cache_lock:
        cache = _facebox_cache_load()
        cache[key] = value
        fd, tmp = tempfile.mkstemp(dir=STATE_DIR, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cache, f)
        os.replace(tmp, FACEBOX_CACHE_PATH)


def _worker_result_to_box(res):
    faces = res.get("faces") or []
    if not faces:
        return None
    f = max(faces, key=lambda x: x.get("score") or 0)
    w, h = res["w"], res["h"]
    x0, y0, x1, y1 = f["bbox"]
    return {
        "x": x0 / w, "y": y0 / h, "w": (x1 - x0) / w, "h": (y1 - y0) / h,
        "kps": [[x / w, y / h] for x, y, _s in f["kps"]],
        "nw": w, "nh": h, "m": "anime",
    }


# --- metadata store (sqlite; extraction ported from the page's JS) ---------

_metadata_db = None
_metadata_lock = threading.RLock()   # guards the single shared connection
_meta_versions = {}                  # host -> int, bumped on every merge


def _db():
    global _metadata_db
    with _metadata_lock:
        if _metadata_db is None:
            _metadata_db = sqlite3.connect(METADATA_DB_PATH,
                                           check_same_thread=False)
            _metadata_db.execute("PRAGMA journal_mode=WAL")
            _metadata_db.execute("PRAGMA busy_timeout=5000")
            _metadata_db.execute(
                """
                CREATE TABLE IF NOT EXISTS images (
                    host TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    meta TEXT,                    -- extracted metadata JSON
                    source TEXT,                  -- 'history' | 'png'
                    has_workflow INTEGER DEFAULT 0,  -- PNG had a workflow chunk
                    nopng INTEGER DEFAULT 0,  -- PNG parsed, no prompt chunk
                    updated_at REAL,
                    PRIMARY KEY (host, filename)
                )
                """)
            _metadata_db.commit()
            _import_legacy_cache(_metadata_db)
        return _metadata_db


def _import_legacy_cache(db):
    """One-time import of metadata_cache.json; renamed to .imported after."""
    try:
        with open(METADATA_CACHE_PATH, encoding="utf-8") as f:
            legacy = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return
    rows = []
    for key, meta in legacy.items():
        host, sep, fn = key.partition(":")
        if sep and isinstance(meta, dict):
            rows.append((host, fn, json.dumps(meta, ensure_ascii=False),
                         "import", 0, 0, time.time()))
    if rows:
        db.executemany(
            "INSERT OR IGNORE INTO images VALUES (?,?,?,?,?,?,?)", rows)
        db.commit()
    os.replace(METADATA_CACHE_PATH, METADATA_CACHE_PATH + ".imported")
    print(f"imported {len(rows)} legacy metadata entries into metadata.db")


def _meta_version_bump(host):
    _meta_versions[host] = _meta_versions.get(host, 0) + 1


def meta_put(host, mapping, source, has_workflow=False):
    """Batch-upsert {filename: meta}. A 'png' row clears the nopng marker;
    has_workflow is sticky (history upserts never erase it)."""
    if not mapping:
        return
    now = time.time()
    with _metadata_lock:
        db = _db()
        db.executemany(
            "INSERT INTO images (host, filename, meta, source,"
            " has_workflow, nopng, updated_at) VALUES (?,?,?,?,?,0,?)"
            " ON CONFLICT(host, filename) DO UPDATE SET"
            " meta=excluded.meta, source=excluded.source,"
            " has_workflow=MAX(images.has_workflow, excluded.has_workflow),"
            " nopng=CASE WHEN excluded.source='png' THEN 0"
            "            ELSE images.nopng END,"
            " updated_at=excluded.updated_at",
            [(host, fn, json.dumps(m, ensure_ascii=False), source,
              1 if has_workflow else 0, now)
             for fn, m in mapping.items()])
        db.commit()
    _meta_version_bump(host)


def meta_mark_nopng(host, filenames):
    """Negative markers for valid PNGs without a prompt chunk — never
    refetched. INSERT OR IGNORE: never clobbers a real metadata row."""
    if not filenames:
        return
    now = time.time()
    with _metadata_lock:
        db = _db()
        db.executemany(
            "INSERT OR IGNORE INTO images (host, filename, meta, source,"
            " has_workflow, nopng, updated_at) VALUES (?,?,NULL,'png',0,1,?)",
            [(host, fn, now) for fn in filenames])
        db.commit()


def meta_all(host):
    """filename -> meta for serving; hasWorkflow injected when known."""
    with _metadata_lock:
        rows = _db().execute(
            "SELECT filename, meta, has_workflow FROM images"
            " WHERE host=? AND meta IS NOT NULL", (host,)).fetchall()
    out = {}
    for fn, m, hw in rows:
        meta = json.loads(m)
        if hw:
            meta["hasWorkflow"] = True
        out[fn] = meta
    return out


def meta_known(host):
    """Filenames with any row (real metadata or nopng marker)."""
    with _metadata_lock:
        rows = _db().execute(
            "SELECT filename FROM images WHERE host=?", (host,)).fetchall()
    return {r[0] for r in rows}


def _walk_text(graph, start_link):
    """Follow positive/negative input links until a node with string text.
    A ConditioningZeroOut on the path means an intentionally empty prompt."""
    node = graph.get(start_link[0]) if isinstance(start_link, list) else None
    for _ in range(8):
        if not node:
            return ""
        if "zeroout" in (node.get("class_type") or "").lower():
            return ""
        text = node.get("inputs", {}).get("text")
        if isinstance(text, str):
            return text
        nxt = next((v for v in node.get("inputs", {}).values()
                    if isinstance(v, list)), None)
        node = graph.get(nxt[0]) if nxt else None
    return ""


def extract_meta(entry):
    """Per-image metadata from one /api/history entry's prompt graph."""
    prompt = entry.get("prompt")
    if not isinstance(prompt, list) or len(prompt) < 3:
        return None
    graph = prompt[2]
    if not isinstance(graph, dict):
        return None
    nodes = list(graph.values())
    ks = next((n for n in nodes if n.get("class_type") == "KSampler"), None)
    if ks is None:
        ks = next((n for n in nodes
                   if "sampler" in (n.get("class_type") or "").lower()), None)
    meta = {"loras": []}
    if isinstance(prompt[0], (int, float)):
        meta["q"] = prompt[0]                     # queue order
    if ks:
        for k in ("seed", "steps", "cfg", "sampler_name", "scheduler",
                  "denoise"):
            v = ks.get("inputs", {}).get(k)
            # linked inputs arrive as [node, slot] lists — not displayable
            if isinstance(v, (int, float, str)):
                meta[k] = v
        meta["prompt"] = _walk_text(graph, ks.get("inputs", {})
                                    .get("positive")).strip()
        meta["negPrompt"] = _walk_text(graph, ks.get("inputs", {})
                                       .get("negative")).strip()
    for n in nodes:
        ct = (n.get("class_type") or "")
        if "lora" in ct.lower() and "load" in ct.lower():
            inp = n.get("inputs", {})
            meta["loras"].append({
                "name": inp.get("lora_name") or inp.get("lora") or "?",
                "strength": inp.get("lora_strength",
                                   inp.get("strength_model",
                                           inp.get("strength"))),
            })
    latent = next((n for n in nodes
                   if "latent" in (n.get("class_type") or "").lower()
                   and "empty" in (n.get("class_type") or "").lower()), None)
    if latent:
        w = latent.get("inputs", {}).get("width")
        h = latent.get("inputs", {}).get("height")
        if isinstance(w, (int, float)) and isinstance(h, (int, float)):
            meta["width"], meta["height"] = w, h
    return meta


def history_output_metas(history):
    """filename -> meta for every output image in a /api/history response."""
    out = {}
    for entry in history.values():
        meta = extract_meta(entry)
        if not meta:
            continue
        for output in (entry.get("outputs") or {}).values():
            for img in output.get("images", []):
                if img.get("type") == "output" and img.get("filename"):
                    out[img["filename"]] = meta
    return out


# --- PNG metadata: tEXt/zTXt/iTXt chunks (ComfyUI writes them pre-IDAT) ----

PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_READ_CAP = 256 * 1024   # safety cap on stream reads before IDAT


def parse_png_text_chunks(stream):
    """Read PNG chunks from a binary stream until the first IDAT; returns
    {keyword: str}, or None if the stream isn't a PNG. Stops early —
    ComfyUI writes prompt/workflow right after IHDR."""
    if stream.read(8) != PNG_SIG:
        return None
    out = {}
    total = 8
    while total < PNG_READ_CAP:
        hdr = stream.read(8)
        if len(hdr) < 8:
            break
        length, ctype = struct.unpack(">I4s", hdr)
        if ctype == b"IDAT":
            break
        data = stream.read(length + 4)   # payload + CRC
        total += 12 + length
        if len(data) < length + 4:
            break
        payload = data[:length]
        try:
            if ctype == b"tEXt":
                key, _, val = payload.partition(b"\x00")
                out[key.decode("latin1")] = val.decode("latin1")
            elif ctype == b"zTXt":
                key, _, rest = payload.partition(b"\x00")
                if rest[:1] == b"\x00":   # method 0 = zlib
                    out[key.decode("latin1")] = zlib.decompress(
                        rest[1:]).decode("utf-8", "replace")
            elif ctype == b"iTXt":
                key, _, rest = payload.partition(b"\x00")
                if len(rest) >= 2:
                    compressed = rest[0]
                    rest = rest[2:]       # flag + method bytes
                    _lang, _, rest = rest.partition(b"\x00")
                    _trans, _, text = rest.partition(b"\x00")
                    if compressed:
                        text = zlib.decompress(text)
                    out[key.decode("latin1")] = text.decode(
                        "utf-8", "replace")
        except (ValueError, zlib.error, UnicodeDecodeError):
            continue
    return out


def meta_from_png_stream(stream):
    """(meta, has_workflow) from a PNG byte stream; meta is None when the
    file carries no prompt chunk (e.g. edited/re-exported PNGs)."""
    chunks = parse_png_text_chunks(stream)
    if chunks is None:
        return None, False
    has_wf = "workflow" in chunks
    try:
        graph = json.loads(chunks["prompt"])
    except (KeyError, json.JSONDecodeError):
        return None, has_wf
    if not isinstance(graph, dict):
        return None, has_wf
    # the prompt chunk IS the executed API-format graph — the same shape
    # extract_meta consumes from history entries
    return extract_meta({"prompt": [0, 0, graph]}), has_wf


# --- metadata extraction worker (one thread per host) -----------------------
# Priority queue: client-reported visible filenames first (meta-want —
# always active), then the background listing walk (only when the scraper
# toggle is enabled). Single-flight with a short inter-file delay keeps
# ComfyUI's API responsive while it generates.

_meta_workers = {}           # host -> worker state dict
_meta_workers_lock = threading.Lock()
_scraper_resume = threading.Event()    # clear = paused
_scraper_resume.set()
SCRAPER_INTER_FILE_DELAY = 0.1         # seconds between file fetches
SCRAPER_MAX_ERRORS = 3                 # consecutive transport errors -> nap


def _meta_worker_ensure(host):
    with _meta_workers_lock:
        w = _meta_workers.get(host)
        if w is None:
            w = {"wake": threading.Event(), "prio": deque(),
                 "prio_set": set(), "walk": deque(), "walk_set": set(),
                 "inflight": None}
            _meta_workers[host] = w
            threading.Thread(target=_meta_worker_main, args=(host,),
                             daemon=True,
                             name=f"meta-worker-{host}").start()
        return w


def _meta_pending(host):
    w = _meta_workers.get(host)
    if not w:
        return 0
    with _meta_workers_lock:
        return len(w["prio"]) + len(w["walk"]) + (1 if w["inflight"] else 0)


def _meta_worker_feed(host, names, priority=False):
    """Queue names that the store doesn't know yet. Returns pending count."""
    if not names:
        return _meta_pending(host)
    known = meta_known(host)
    w = _meta_worker_ensure(host)
    with _meta_workers_lock:
        for name in names:
            if name in known or name in w["prio_set"]:
                continue
            if priority:
                # promote from the walk queue: prio drains even when the
                # background walk is disabled
                if name in w["walk_set"]:
                    w["walk_set"].discard(name)
                    try:
                        w["walk"].remove(name)
                    except ValueError:
                        pass
                w["prio"].append(name)
                w["prio_set"].add(name)
            elif name not in w["walk_set"]:
                w["walk"].append(name)
                w["walk_set"].add(name)
        w["wake"].set()
        return len(w["prio"]) + len(w["walk"])


def _meta_worker_main(host):
    base = host_base(host)
    w = _meta_workers[host]
    errors = 0
    while True:
        with _meta_workers_lock:
            w["inflight"] = None
            if w["prio"]:
                name = w["prio"].popleft()
                w["prio_set"].discard(name)
            elif SCRAPER_ENABLED and w["walk"]:
                name = w["walk"].popleft()
                w["walk_set"].discard(name)
            else:
                name = None
                w["wake"].clear()
            if name is not None:
                w["inflight"] = name
        if name is None:
            w["wake"].wait(30)   # idle; cheap periodic re-check
            continue
        _scraper_resume.wait()   # pause gate (blocks while paused)
        url = (f"{base}/api/view?type=output&filename="
               + urllib.parse.quote(name))
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=IMAGE_TIMEOUT) as resp:
                meta, has_wf = meta_from_png_stream(resp)
            errors = 0
        except urllib.error.HTTPError as e:
            if e.code == 404:
                # gone from the host — permanent; never retry
                meta_mark_nopng(host, [name])
                continue
            errors += 1
            with _meta_workers_lock:
                w["inflight"] = None
                if name not in w["walk_set"]:
                    w["walk"].append(name)
                    w["walk_set"].add(name)
            time.sleep(min(2 ** errors, 30))
            continue
        except Exception:
            errors += 1
            # host stalled/down: requeue for later, back off progressively
            with _meta_workers_lock:
                w["inflight"] = None
                if name not in w["walk_set"]:
                    w["walk"].append(name)
                    w["walk_set"].add(name)
            time.sleep(min(2 ** errors, 30))
            continue
        if meta:
            meta_put(host, {name: meta}, "png", has_workflow=has_wf)
        else:
            meta_mark_nopng(host, [name])
        time.sleep(SCRAPER_INTER_FILE_DELAY)


def clean_file_name(entry):
    """Port of the page's cleanFileName: strip the " [123]" suffix the
    /internal/files/output listing appends."""
    return re.sub(r"\s+\[[^\]]+\]$", "", str(entry))


def facebox_for_bytes(key, image_bytes):
    cached = _facebox_cache_load()
    if key in cached:
        return cached[key]
    box = _worker_result_to_box(face_detect(image_bytes))
    _facebox_cache_put(key, box)
    return box


# --- HTTP handler -----------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Kosmozoo/1.0"

    def log_message(self, fmt, *args):  # quieter logs
        print(f"{self.address_string()} - {fmt % args}")

    # -- response helpers --

    def _send(self, status, body=b"", content_type="application/json",
              extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False))

    def _send_error_json(self, status, message):
        self._send_json(status, {"error": message})

    # -- routing --

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/":
                self._handle_index()
            elif path in ("/logo-64.png", "/logo-256.png",
                          "/logo-512.png", "/social.png"):
                try:
                    with open(os.path.join(BASE_DIR, path[1:]), "rb") as f:
                        body = f.read()
                    self._send(200, body, "image/png",
                               {"Cache-Control": "max-age=86400"})
                except FileNotFoundError:
                    self._send_error_json(404, "not found")
            elif path == "/api/hosts":
                self._handle_hosts()
            elif path == "/api/files":
                self._handle_files(qs)
            elif path == "/api/image":
                self._handle_image(qs)
            elif path == "/api/history":
                self._handle_history(qs)
            elif path == "/api/metadata":
                self._handle_metadata(qs)
            elif path == "/api/comments":
                self._send(200, json.dumps(read_comments(), ensure_ascii=False),
                           extra_headers={"Cache-Control": "no-store"})
            elif path == "/api/feedback":
                self._handle_feedback_download()
            elif path == "/api/config":
                self._send_json(200, {"feedbackPath": COMMENTS_PATH,
                                      "buckets": BUCKETS,
                                      "hosts": HOSTS,
                                      "scraper": {
                                          "enabled": SCRAPER_ENABLED,
                                          "paused":
                                              not _scraper_resume.is_set()}})
            elif path == "/api/scraper":
                self._handle_scraper_get()
            elif path == "/api/facebox-warmup":
                self._handle_facebox_warmup()

            elif path.startswith("/vendor/"):
                self._handle_vendor(path)
            else:
                self._send_error_json(404, f"unknown endpoint: {path}")
        except BrokenPipeError:
            pass
        except Exception as exc:
            self._send_error_json(502, f"{type(exc).__name__}: {exc}")

    def _drain_chunked(self):
        # Consume a chunked request body so it can't bleed into the next
        # request on a keep-alive connection. (Content-Length-less bodies
        # once corrupted the next request: a sendBeacon's JSON prepended
        # itself to the next request line.)
        while True:
            line = self.rfile.readline().strip()
            try:
                size = int(line, 16)
            except ValueError:
                return
            if size == 0:
                while True:
                    trailer = self.rfile.readline()
                    if trailer in (b"\r\n", b"\n", b""):
                        return
            remaining = size
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    return
                remaining -= len(chunk)
            self.rfile.readline()   # trailing CRLF after each chunk

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self._drain_chunked()
            self._send_error_json(400, "chunked request bodies not supported")
            return
        try:
            if parsed.path == "/api/comments":
                self._handle_post_comment()
            elif parsed.path == "/api/facebox-bytes":
                self._handle_facebox_bytes()
            elif parsed.path == "/api/downloads-check":
                self._handle_downloads_check()
            elif parsed.path == "/api/config":
                self._handle_post_config()
            elif parsed.path == "/api/meta-want":
                self._handle_meta_want()
            elif parsed.path == "/api/scraper":
                self._handle_scraper_post()
            else:
                self._send_error_json(404, f"unknown endpoint: {parsed.path}")
        except BrokenPipeError:
            pass
        except Exception as exc:
            self._send_error_json(502, f"{type(exc).__name__}: {exc}")

    # -- endpoints --

    def _handle_index(self):
        try:
            with open(INDEX_HTML, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            self._send_error_json(404, "index.html not found")
            return
        self._send(200, body, "text/html; charset=utf-8",
                   {"Cache-Control": "no-store"})

    def _handle_hosts(self):
        # Probe in parallel: total wait is the slowest host, not the sum.
        results = {}

        def probe(name, addr):
            results[name] = probe_host(addr)

        threads = [threading.Thread(target=probe, args=(n, a), daemon=True)
                   for n, a in HOSTS.items()]
        for t in threads:
            t.start()
        for t in threads:
            t.join(STATUS_TIMEOUT + 2)
        out = [{"name": name, "address": addr,
                "online": results.get(name, False)}
               for name, addr in HOSTS.items()]
        self._send_json(200, out)

    def _require_host(self, qs):
        host = qs.get("host", [None])[0]
        base = host_base(host) if host else None
        if not base:
            self._send_error_json(400, f"unknown host: {host!r}")
        return base

    def _handle_files(self, qs):
        base = self._require_host(qs)
        if not base:
            return
        status, body = fetch_json(f"{base}/internal/files/output",
                                  PROXY_TIMEOUT)
        if status == 200:
            # feed the background walk: files the store doesn't know yet
            try:
                listing = [clean_file_name(f) for f in json.loads(body)]
                _meta_worker_feed(qs["host"][0], listing)
            except (json.JSONDecodeError, TypeError):
                pass
        self._send(status, body, extra_headers={"Cache-Control": "no-store"})

    def _handle_meta_want(self):
        """POST {host, files}: filenames currently on screen — they jump
        the extraction queue. Always active, even when the background
        walk is disabled."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send_error_json(400, "bad body")
            return
        host = payload.get("host")
        if not host_base(host):
            self._send_error_json(400, f"unknown host: {host!r}")
            return
        files = [clean_file_name(f) for f in payload.get("files", [])][:500]
        pending = _meta_worker_feed(host, files, priority=True)
        self._send_json(200, {"ok": True, "pending": pending})

    def _handle_scraper_get(self):
        self._send_json(200, {"enabled": SCRAPER_ENABLED,
                              "paused": not _scraper_resume.is_set()})

    def _handle_scraper_post(self):
        global SCRAPER_ENABLED
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send_error_json(400, "bad body")
            return
        if "enabled" in payload:
            SCRAPER_ENABLED = bool(payload["enabled"])
            cfg = _load_config()
            cfg["scraperEnabled"] = SCRAPER_ENABLED
            fd, tmp = tempfile.mkstemp(dir=STATE_DIR, suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2)
                f.write("\n")
            os.replace(tmp, CONFIG_PATH)
        if "paused" in payload:
            if payload["paused"]:
                _scraper_resume.clear()
            else:
                _scraper_resume.set()
        # wake all workers so they notice the state change immediately
        for w in _meta_workers.values():
            w["wake"].set()
        self._send_json(200, {"enabled": SCRAPER_ENABLED,
                              "paused": not _scraper_resume.is_set()})

    def _merge_history_into_metadata(self, host, body_bytes):
        try:
            history = json.loads(body_bytes)
        except json.JSONDecodeError:
            return
        live = history_output_metas(history)
        if not live:
            return
        meta_put(host, live, "history")

    def _handle_history(self, qs):
        base = self._require_host(qs)
        if not base:
            return
        status, body = fetch_json(f"{base}/api/history", PROXY_TIMEOUT)
        if status == 200:
            self._merge_history_into_metadata(qs["host"][0], body)
        self._send(status, body, extra_headers={"Cache-Control": "no-store"})

    def _handle_metadata(self, qs):
        """{items, pending, v}: sqlite store merged with live history
        (live wins; the store covers images whose history vanished).
        pending = files queued for PNG extraction; v = store version."""
        base = self._require_host(qs)
        if not base:
            return
        host = qs["host"][0]
        live = {}
        try:
            status, body = fetch_json(f"{base}/api/history", PROXY_TIMEOUT)
            if status == 200:
                self._merge_history_into_metadata(host, body)
                live = history_output_metas(json.loads(body))
        except Exception:
            pass    # host stalled/down: serve the store alone
        merged = meta_all(host)
        merged.update(live)
        self._send_json(200, {
            "items": merged,
            "pending": _meta_pending(host),
            "v": _meta_versions.get(host, 0),
        })

    def _handle_image(self, qs):
        base = self._require_host(qs)
        if not base:
            return
        filename = qs.get("file", [None])[0]
        if not filename:
            self._send_error_json(400, "missing file parameter")
            return
        if not re.fullmatch(r"[\w.\-/ ]+", filename):
            self._send_error_json(400, "bad filename")
            return
        url = (f"{base}/api/view?type=output&filename="
               + urllib.parse.quote(filename))
        req = urllib.request.Request(url, headers=UA)
        try:
            with urllib.request.urlopen(req, timeout=IMAGE_TIMEOUT) as resp:
                ctype = resp.headers.get(
                    "Content-Type", "application/octet-stream")
                self.send_response(resp.status)
                self.send_header("Content-Type", ctype)
                self.send_header("Cache-Control", "max-age=3600")
                cl = resp.headers.get("Content-Length")
                if cl:
                    self.send_header("Content-Length", cl)
                self.end_headers()
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as exc:
            self._send_error_json(exc.code, f"upstream: {exc.reason}")

    def _handle_feedback_download(self):
        # the exact canonical file, byte-for-byte, as a download
        try:
            with open(COMMENTS_PATH, "rb") as f:
                body = f.read()
        except FileNotFoundError:
            body = b"{}\n"
        self._send(200, body, "application/json", {
            "Content-Disposition": 'attachment; filename="feedback.json"',
            "Cache-Control": "no-store",
        })

    def _handle_downloads_check(self):
        """Existence check by name only (no listing). Basenames only —
        anything path-like returns False without touching the disk."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send_error_json(400, "invalid JSON")
            return
        files = payload.get("files")
        if not isinstance(files, list) or len(files) > 10000 or \
                not all(isinstance(f, str) for f in files):
            self._send_error_json(400, "expected {files: [names]}")
            return
        out = {}
        for f in files:
            out[f] = ("/" not in f and "\\" not in f and
                      os.path.exists(os.path.join(DOWNLOADS_DIR, f)))
        self._send_json(200, {"exists": out})

    def _handle_vendor(self, path):
        rel = path[len("/vendor/"):]
        full = os.path.normpath(os.path.join(VENDOR_DIR, rel))
        # containment check (blocks .. traversal and absolute injection)
        base = os.path.realpath(VENDOR_DIR) + os.sep
        if not rel or not os.path.realpath(full).startswith(base):
            self._send_error_json(400, "bad path")
            return
        ext = os.path.splitext(full)[1]
        ctype = VENDOR_MIME.get(ext, "application/octet-stream")
        try:
            with open(full, "rb") as f:
                body = f.read()
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            self._send_error_json(404, "not found")
            return
        self._send(200, body, ctype,
                   {"Cache-Control": "max-age=86400"})  # pinned assets

    def _handle_facebox_warmup(self):
        global _face_worker
        # blocks until the worker has models loaded (first run downloads)
        with _face_worker_lock:
            if _face_worker is None or _face_worker.poll() is not None:
                _face_worker = None
                _face_worker_start()
        self._send_json(200, {"ready": True})

    def _handle_facebox_bytes(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > 40_000_000:
            self._send_error_json(400, "bad body size")
            return
        # key is the cache identity: "host:file" (candidates) or
        # "anchor:<name>" (anchors) — the client owns namespacing
        key = urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query).get("key", [""])[0]
        if not key or not re.fullmatch(r"[\w.\-: /]+", key):
            self._send_error_json(400, "bad key")
            return
        image_bytes = self.rfile.read(length)
        box = facebox_for_bytes(key, image_bytes)
        self._send_json(200, {"box": box})

    def _handle_post_config(self):
        global COMMENTS_PATH, BUCKETS, HOSTS
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self._send_error_json(400, "invalid JSON")
            return
        cfg = _load_config()
        changed = False
        if "feedbackPath" in payload:
            path = payload["feedbackPath"]
            if not isinstance(path, str) or not path.strip():
                self._send_error_json(400, "expected {feedbackPath} string")
                return
            path = os.path.expanduser(path.strip())
            if not path.startswith("/"):
                self._send_error_json(400, "must be an absolute path")
                return
            if not os.path.isdir(os.path.dirname(path) or "/"):
                self._send_error_json(400, "parent directory doesn't exist")
                return
            COMMENTS_PATH = path
            cfg["feedbackPath"] = path
            changed = True
        if "buckets" in payload:
            buckets = payload["buckets"]
            if not isinstance(buckets, list) or not buckets or \
                    not all(isinstance(b, str) and b.strip()
                            for b in buckets):
                self._send_error_json(
                    400, "buckets must be a non-empty list of strings")
                return
            BUCKETS = [b.strip() for b in buckets]
            cfg["buckets"] = BUCKETS
            changed = True
        if "hosts" in payload:
            hosts = payload["hosts"]
            if not isinstance(hosts, dict) or not hosts or \
                    not all(isinstance(k, str) and isinstance(v, str)
                            and re.fullmatch(r"[\w.\-]+", k)
                            and re.fullmatch(r"[\w.\-:]+", v)
                            for k, v in hosts.items()):
                self._send_error_json(
                    400, "hosts must be {name: host:port} strings")
                return
            HOSTS = dict(hosts)
            cfg["hosts"] = HOSTS
            changed = True
        if not changed:
            self._send_error_json(400, "nothing to update")
            return
        fd, tmp = tempfile.mkstemp(dir=STATE_DIR, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        os.replace(tmp, CONFIG_PATH)
        self._send_json(200, {"ok": True, "feedbackPath": COMMENTS_PATH,
                              "buckets": BUCKETS})

    def _handle_post_comment(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._send_error_json(400, "bad Content-Length")
            return
        if length <= 0 or length > 1_000_000:
            self._send_error_json(400, "bad body size")
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except json.JSONDecodeError:
            self._send_error_json(400, "invalid JSON")
            return
        host = payload.get("host")
        file = payload.get("file")
        if not isinstance(host, str) or not isinstance(file, str) \
                or host not in HOSTS or not file:
            self._send_error_json(400, "expected {host (known), file}")
            return
        fields = {}
        for k in ("neg", "pos"):
            if k in payload:
                if not isinstance(payload[k], str):
                    self._send_error_json(400, f"{k} must be a string")
                    return
                fields[k] = payload[k]
        if "vote" in payload:
            if payload["vote"] not in ("up", "down", None):
                self._send_error_json(400, "vote must be 'up'|'down'|null")
                return
            fields["vote"] = payload["vote"]
        if "bucket" in payload:
            if payload["bucket"] not in list(BUCKETS) + ["", None]:
                self._send_error_json(
                    400, f"bucket must be one of {BUCKETS} or empty")
                return
            fields["bucket"] = payload["bucket"]
        if "tag" in payload:
            if payload["tag"] not in TAGS + (None,):
                self._send_error_json(
                    400, f"tag must be one of {TAGS} or null")
                return
            fields["tag"] = payload["tag"]
        if not fields:
            self._send_error_json(400, "nothing to update")
            return
        data = upsert_comment(f"{host}:{file}", fields)
        self._send_json(200, {"ok": True, "count": len(data)})


def main():
    server = ThreadingHTTPServer((BIND, PORT), Handler)
    shown = "127.0.0.1" if BIND == "0.0.0.0" else BIND
    print(f"Kosmozoo review server on http://{shown}:{PORT}"
          + (" (all interfaces)" if BIND == "0.0.0.0" else ""))
    print(f"Hosts: {', '.join(f'{k} ({v})' for k, v in HOSTS.items())}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
