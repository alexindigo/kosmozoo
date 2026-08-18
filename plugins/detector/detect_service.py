#!/usr/bin/env python3
"""Kosmozoo detection service — HTTP wrapper around detect_worker.py.

Relocates the detection worker behind HTTP so it lives OUTSIDE kosmozoo core
(a plugin's backing service is its own business). The JSONL worker is spawned
as a subprocess and its protocol is wrapped in a tiny HTTP API. This is not a
rewrite — the detector and its 92%-on-60-images track record move unchanged.

Two flaws in the outgoing integration are fixed here, both harvested:
  - the read had no timeout (a wedged worker hung a request while holding a
    lock) — every subprocess call now carries a deadline;
  - stderr was DEVNULL (every diagnostic swallowed) — worker stderr is
    captured and surfaced on /health.

Endpoints:
  GET  /health        -> {"ready": bool, "stderr_tail": [...], "model": str}
  POST /detect        -> body: image bytes; resp: {"w","h","faces":[{bbox,score,kps}]}

The response carries the 28-point keypoints (eyes are groups 11–16 and
17–22); the detector plugin (client side) derives eye midpoint + inter-eye
distance from them — the two numbers the alignment transform consumes.

Run:  python3 detect_service.py [port]      (default 8471)
"""

import base64
import json
import os
import queue
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WORKER = str(Path(__file__).parent / "detect_worker.py")
READ_TIMEOUT = 60  # seconds — a wedged worker must not hang a request


class Worker:
    """One detect_worker subprocess; JSONL over stdin/stdout with a deadline."""

    def __init__(self):
        self.proc = None
        self.stderr_tail = []
        self.lock = threading.Lock()
        self._spawn()

    def _spawn(self):
        env = dict(os.environ)
        self.proc = subprocess.Popen(
            [sys.executable, WORKER],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,  # surfaced, not DEVNULL
            env=env, text=True, bufsize=1,
        )
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stderr(self):
        for line in self.proc.stderr:
            self.stderr_tail.append(line.rstrip())
            del self.stderr_tail[:-50]  # keep the last 50 lines

    def ready(self):
        return self.proc is not None and self.proc.poll() is None

    def detect(self, image_bytes, req_id=0):
        with self.lock:  # single-flight: one request on the wire at a time
            line = json.dumps({"id": req_id, "b64": base64.b64encode(image_bytes).decode()})
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
            # readline with a deadline via a watcher thread
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
            return json.loads(resp)

    def _restart(self):
        try:
            self.proc.kill()
        except Exception:
            pass
        self._spawn()


worker = None  # lazily created on first /detect so /health works pre-model


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
            global worker
            self._json(200, {
                "ready": bool(worker and worker.ready()),
                "model": "anime-face-detector",
                "stderr_tail": (worker.stderr_tail if worker else [])[-10:],
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/detect":
            return self._json(404, {"error": "not found"})
        global worker
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        if worker is None:
            worker = Worker()
        try:
            res = worker.detect(body)
            self._json(200, res)
        except (TimeoutError, RuntimeError) as e:
            self._json(503, {"error": str(e)})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8471
    print(f"kosmozoo detect service on :{port} (worker: {WORKER})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
