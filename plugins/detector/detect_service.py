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
import socket
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
REQUEST_READ_TIMEOUT = 10  # absolute header + body budget, separate from inference
MAX_REQUESTS = 8  # detection uploads + queued/running inference
CONTROL_REQUEST_RESERVE = 2  # HTTP readers beyond detection capacity, still finite


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


class BoundedHTTPServer(ThreadingHTTPServer):
    def __init__(self, *args, **kwargs):
        self.slots = threading.BoundedSemaphore(MAX_REQUESTS + CONTROL_REQUEST_RESERVE)
        self.detection_slots = threading.BoundedSemaphore(MAX_REQUESTS)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def handle_one_request(self):
        self.connection.settimeout(REQUEST_READ_TIMEOUT)
        self._read_expired = threading.Event()
        self._read_timer = threading.Timer(REQUEST_READ_TIMEOUT, self._expire_read)
        self._read_timer.daemon = True
        self._read_timer.start()
        try:
            super().handle_one_request()
        finally:
            self._read_timer.cancel()

    def _expire_read(self):
        # A socket inactivity timeout alone can be extended forever by drips.
        # Interrupt only reads, so an incomplete body can still receive a 408.
        self._read_expired.set()
        try:
            self.connection.shutdown(socket.SHUT_RD)
        except OSError:
            pass  # request already closed

    def log_message(self, *a):  # quiet
        pass

    def _json(self, code, obj):
        self._read_timer.cancel()
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
        if self._read_expired.is_set():
            return self._json(408, {"error": "request read deadline exceeded"})
        if self.path != "/detect":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._json(400, {"error": "invalid Content-Length"})
        if length <= 0:
            return self._json(400, {"error": "empty body", "reason": "no image bytes"})
        if length > MAX_BODY:
            return self._json(413, {"error": "body too large", "reason": f">{MAX_BODY} bytes"})
        # Admit only parsed detections, before retaining uploads. Queued inference
        # cannot consume the bounded reserve used by health/control readers.
        if not self.server.detection_slots.acquire(blocking=False):
            return self._json(503, {"error": "detector overloaded"})
        try:
            self._detect(length)
        finally:
            self.server.detection_slots.release()

    def _detect(self, length):
        try:
            body = self.rfile.read(length)
        except TimeoutError:
            return self._json(408, {"error": "request read deadline exceeded"})
        if len(body) != length or self._read_expired.is_set():
            return self._json(408, {"error": "incomplete request body"})
        self._read_timer.cancel()  # inference has its own worker deadline
        try:
            res = worker.detect(body)
            # A correlated worker error is a completed request, not protocol
            # skew. Keep the healthy worker and preserve its diagnostic/id.
            self._json(422 if "error" in res else 200, res)
        except Exception as e:  # broad on purpose: 503 with a reason, never a hang
            self._json(503, {"error": "detect failed", "reason": str(e)})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8471
    worker = Worker()  # spawned at startup — /health is honest pre-model
    print(f"kosmozoo detect service on :{port} (worker: {WORKER})", flush=True)
    BoundedHTTPServer(("127.0.0.1", port), Handler).serve_forever()
