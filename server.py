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
import subprocess
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --- Config ---------------------------------------------------------------
# Hosts shown in the dropdown. Label -> host:port of a ComfyUI server.
# host-b-sibling intentionally omitted (broken, being re-formatted 2026-08-14).
HOSTS = {
    "host-a": "comfyui.local:8188",
    "host-b": "anton.local:8888",
    "host-c": "ark.local:8188",
}

BIND = "127.0.0.1"
# all overridable from the environment
PORT = int(os.environ.get("KOZMOZOO_PORT", "2084"))

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
# feedback.json is canonical curation data and lives OUTSIDE the repo.
# The path is configurable (☰ menu); persisted in config.json (gitignored).
DEFAULT_COMMENTS_PATH = os.path.expanduser(
    os.environ.get("KOZMOZOO_FEEDBACK", "~/Documents/kosmozoo_feedback.json"))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")


def _load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


_cfg = _load_config()
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

# curation buckets (stored per image in feedback.json entries) —
# configurable: config.json "buckets" or KOZMOZOO_BUCKETS env; the default
# is generic on purpose
DEFAULT_BUCKETS = ["good", "almost", "needs_work", "reject", "other",
                   "broken"]
# note-type tags; "character" is the default and is stored as "absent"
TAGS = ("character", "scene", "style")

# local anime face detection (detect_worker.py in the project venv)
FACEWORKER_PY = os.path.join(BASE_DIR, ".venv", "bin", "python")
DETECT_WORKER = os.path.join(BASE_DIR, "detect_worker.py")
FACEBOX_CACHE_PATH = os.path.join(BASE_DIR, "faceboxes_cache.json")

# persistent metadata cache: ComfyUI /api/history is volatile (lost on the
# host's restart), so every fetched history entry's per-image metadata is
# merged into metadata_cache.json and never deleted
METADATA_CACHE_PATH = os.path.join(BASE_DIR, "metadata_cache.json")

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
        fd, tmp = tempfile.mkstemp(dir=BASE_DIR, suffix=".tmp")
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


# --- metadata extraction + persistent cache (ported from the page's JS) ----

_metadata_cache = None
_metadata_lock = threading.RLock()   # merge re-enters via _load()


def _metadata_cache_load():
    global _metadata_cache
    with _metadata_lock:
        if _metadata_cache is None:
            try:
                with open(METADATA_CACHE_PATH, encoding="utf-8") as f:
                    _metadata_cache = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                _metadata_cache = {}
        return _metadata_cache


def _metadata_cache_save():
    fd, tmp = tempfile.mkstemp(dir=BASE_DIR, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(_metadata_cache, f)
    os.replace(tmp, METADATA_CACHE_PATH)


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
            if v is not None:
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
                                      "buckets": BUCKETS})
            elif path == "/api/facebox-warmup":
                self._handle_facebox_warmup()
            elif path == "/api/downloads":
                self._handle_downloads()
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
            elif parsed.path == "/api/config":
                self._handle_post_config()
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
        self._send(status, body, extra_headers={"Cache-Control": "no-store"})

    def _merge_history_into_metadata(self, host, body_bytes):
        try:
            history = json.loads(body_bytes)
        except json.JSONDecodeError:
            return
        live = history_output_metas(history)
        if not live:
            return
        with _metadata_lock:
            cache = _metadata_cache_load()
            cache.update({f"{host}:{k}": v for k, v in live.items()})
            _metadata_cache_save()

    def _handle_history(self, qs):
        base = self._require_host(qs)
        if not base:
            return
        status, body = fetch_json(f"{base}/api/history", PROXY_TIMEOUT)
        if status == 200:
            self._merge_history_into_metadata(qs["host"][0], body)
        self._send(status, body, extra_headers={"Cache-Control": "no-store"})

    def _handle_metadata(self, qs):
        """filename -> meta: persistent cache merged with live history
        (live wins; cache covers images whose history vanished)."""
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
            pass    # host stalled/down: serve cache alone
        cache = _metadata_cache_load()
        prefix = host + ":"
        merged = {k[len(prefix):]: v for k, v in cache.items()
                  if k.startswith(prefix)}
        merged.update(live)
        self._send(200, json.dumps(merged, ensure_ascii=False),
                   extra_headers={"Cache-Control": "no-store"})

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

    def _handle_downloads(self):
        try:
            names = os.listdir(DOWNLOADS_DIR)
        except (FileNotFoundError, PermissionError):
            names = []
        self._send(200, json.dumps({"files": names}, ensure_ascii=False),
                   extra_headers={"Cache-Control": "no-store"})

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
        global COMMENTS_PATH, BUCKETS
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
        if not changed:
            self._send_error_json(400, "nothing to update")
            return
        fd, tmp = tempfile.mkstemp(dir=BASE_DIR, suffix=".tmp")
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
            if payload["bucket"] not in BUCKETS + ("", None):
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
    print(f"Kosmozoo review server on http://{BIND}:{PORT}")
    print(f"Hosts: {', '.join(f'{k} ({v})' for k, v in HOSTS.items())}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
