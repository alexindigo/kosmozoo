#!/usr/bin/env python3
"""Kosmozoo detection service — HTTP wrapper around detect_worker.py.

Relocates the detection worker behind HTTP so it lives OUTSIDE kosmozoo core
(a plugin's backing service is its own business). The JSONL worker is spawned
as a subprocess and its protocol is wrapped in a tiny HTTP API.

Protocol discipline (the bugs this version fixes):
  - the worker prints {"ready": true} after loading its models — the service
    CONSUMES that handshake; without it every response is off by one request
    (the first /detect got the ready line, so faces landed on the wrong image)
  - requests carry an incrementing id; the response id is asserted — a
    mismatched response means protocol skew, and the worker is restarted
  - the worker is spawned at startup (with a lock), not lazily mid-request
  - stderr is captured to a bounded deque (last 50 lines), surfaced on /health
  - every subprocess call carries a deadline; broad failures answer 503 with
    a reason, never a hang
  - /health reports model_ready + deadline_ms (the plugin honors ONE value —
    it never hardcodes its own)

Endpoints:
  GET  /health  -> {"model_ready": bool, "model": str, "deadline_ms": int,
                    "stderr_tail": [...]}
  POST /detect  -> body: image bytes; resp: {"w","h","faces":[{bbox,score,kps}]}

Run:  python3 detect_service.py [port]      (default 8471)
Worker override (tests): DETECT_WORKER=/path/to/stub_worker.py
"""

import base64
import json
import os
import queue
import subprocess
import sys
import threading
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WORKER = os.environ.get("DETECT_WORKER", str(Path(__file__).parent / "detect_worker.py"))
READ_TIMEOUT = 60  # seconds — a wedged worker must not hang a request
DEADLINE_MS = READ_TIMEOUT * 1000  # the ONE deadline; /health exposes it
MAX_BODY = 32 * 1024 * 1024  # 32 MB — bigger images are a client bug


class Worker:
    """One detect_worker subprocess; JSONL over stdin/stdout with a deadline."""

    def __init__(self):
        self.proc = None
        self.stderr_tail = deque(maxlen=50)  # bounded, surfaced on /health
        self.lock = threading.Lock()         # single-flight on the wire
        self.spawn_lock = threading.Lock()   # one spawn at a time
        self.model_ready = False
        self.req_id = 0
        self._spawn()

    def _spawn(self):
        with self.spawn_lock:
            self.proc = subprocess.Popen(
                [sys.executable, WORKER],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,  # surfaced, not DEVNULL
                env=dict(os.environ), text=True, bufsize=1,
            )
            threading.Thread(target=self._drain_stderr, daemon=True).start()
            # consume the ready handshake — otherwise it would be returned as
            # the first detect's response (off by one for the worker's life)
            self.model_ready = False
            self._readline_ready()

    def _readline_ready(self):
        q = queue.Queue(maxsize=1)
        threading.Thread(target=lambda: q.put(self.proc.stdout.readline()),
                         daemon=True).start()
        try:
            line = q.get(timeout=READ_TIMEOUT)
            self.model_ready = bool(json.loads(line).get("ready"))
        except Exception:
            self.model_ready = False

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self.stderr_tail.append(line.rstrip())

    def ready(self):
        return self.proc is not None and self.proc.poll() is None and self.model_ready

    def detect(self, image_bytes):
        with self.lock:
            self.req_id += 1
            req_id = self.req_id
            line = json.dumps({"id": req_id, "b64": base64.b64encode(image_bytes).decode()})
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
            q = queue.Queue(maxsize=1)
            threading.Thread(target=lambda: q.put(self.proc.stdout.readline()),
                             daemon=True).start()
            try:
                resp = q.get(timeout=READ_TIMEOUT)
            except queue.Empty:
                self._restart()
                raise TimeoutError("detect worker wedged; restarted")
            if not resp:
                self._restart()
                raise RuntimeError("detect worker died; restarted")
            data = json.loads(resp)
            # protocol skew check: a response for another request means the
            # wire is off by one (a leftover ready line, a swallowed error)
            if data.get("id") != req_id:
                self._restart()
                raise RuntimeError(
                    f"detect worker out of sync (wanted id {req_id}, got {data.get('id')}); restarted")
            return data

    def _restart(self):
        try:
            self.proc.kill()
        except Exception:
            pass
        self._spawn()


worker = None  # spawned at startup in main()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "model_ready": bool(worker and worker.ready()),
                "model": "anime-face-detector",
                "deadline_ms": DEADLINE_MS,
                "stderr_tail": list(worker.stderr_tail)[-10:] if worker else [],
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/detect":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self._json(400, {"error": "empty body", "reason": "no image bytes"})
        if length > MAX_BODY:
            return self._json(413, {"error": "body too large", "reason": f">{MAX_BODY} bytes"})
        body = self.rfile.read(length)
        try:
            res = worker.detect(body)
            self._json(200, res)
        except Exception as e:  # broad on purpose: 503 with a reason, never a hang
            self._json(503, {"error": "detect failed", "reason": str(e)})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8471
    worker = Worker()  # spawned at startup — /health is honest pre-model
    print(f"kosmozoo detect service on :{port} (worker: {WORKER})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
