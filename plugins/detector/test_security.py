"""Detector HTTP resource limits and real OpenCV decompression boundary."""
import base64
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest
import zlib

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('detect_service', HERE / 'detect_service.py')
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class StubWorker:
    stderr_tail = []

    def ready(self):
        return True

    def detect(self, body):
        return {'bytes': len(body)}


class HTTPBudget(unittest.TestCase):
    def setUp(self):
        service.worker = StubWorker()
        self.old_timeout = getattr(service, 'REQUEST_READ_TIMEOUT', None)
        self.old_capacity = getattr(service, 'MAX_REQUESTS', None)
        service.REQUEST_READ_TIMEOUT = 0.2
        service.MAX_REQUESTS = 2
        server_class = getattr(service, 'BoundedHTTPServer', service.ThreadingHTTPServer)
        self.server = server_class(('127.0.0.1', 0), service.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        service.REQUEST_READ_TIMEOUT = self.old_timeout
        service.MAX_REQUESTS = self.old_capacity

    def connect(self):
        return socket.create_connection(('127.0.0.1', self.port), timeout=1)

    def test_partial_headers_and_body_have_absolute_read_deadline(self):
        for request in [b'POST /detect HTTP/1.0\r\nContent-Length: ',
                        b'POST /detect HTTP/1.0\r\nContent-Length: 10\r\n\r\nx']:
            with self.subTest(request=request), self.connect() as client:
                client.sendall(request)
                started = time.monotonic()
                try:
                    reply = client.recv(4096)
                except socket.timeout:
                    self.fail('incomplete request retained its thread beyond the read deadline')
                self.assertLess(time.monotonic() - started, 0.9)
                self.assertTrue(not reply or b'408' in reply or b'400' in reply)

    def test_request_threads_are_bounded(self):
        service.REQUEST_READ_TIMEOUT = 2
        clients = [self.connect(), self.connect()]
        try:
            time.sleep(0.05)
            with self.connect() as overflow:
                overflow.sendall(b'GET /health HTTP/1.0\r\n\r\n')
                try:
                    response = overflow.recv(4096)
                except ConnectionResetError:
                    response = b''
                self.assertEqual(response, b'', 'excess request acquired an unbounded native thread')
        finally:
            for client in clients:
                client.close()

    def test_dripping_body_cannot_extend_absolute_deadline(self):
        with self.connect() as client:
            client.sendall(b'POST /detect HTTP/1.0\r\nContent-Length: 100\r\n\r\n')
            def drip():
                for _ in range(20):
                    try:
                        client.sendall(b'x')
                    except OSError:
                        return
                    time.sleep(0.04)
            sender = threading.Thread(target=drip, daemon=True)
            started = time.monotonic()
            sender.start()
            try:
                self.assertIn(b'408', client.recv(4096))
                self.assertLess(time.monotonic() - started, 0.9)
            finally:
                client.shutdown(socket.SHUT_RDWR)
                sender.join(timeout=1)

    def test_finished_upload_has_separate_inference_deadline(self):
        class SlowWorker(StubWorker):
            def detect(self, body):
                time.sleep(0.4)
                return super().detect(body)
        service.worker = SlowWorker()
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
        try:
            conn.request('POST', '/detect', b'img')
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read())['bytes'], 3)
        finally:
            conn.close()

    def test_complete_body_still_reaches_worker_and_invalid_length_is_400(self):
        for length, expected in [('3', 200), ('bad', 400), ('-1', 400)]:
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
            try:
                conn.request('POST', '/detect', b'img', {'Content-Length': length})
                response = conn.getresponse()
                self.assertEqual(response.status, expected)
                data = json.loads(response.read())
                if expected == 200:
                    self.assertEqual(data['bytes'], 3)
            finally:
                conn.close()


def png(width, height):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    compressor = zlib.compressobj()
    parts = [compressor.compress(b'\x00' * (1 + width * 3)) for _ in range(height)]
    data = b''.join(parts) + compressor.flush()
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', data) + chunk(b'IEND', b'')


@unittest.skipUnless(importlib.util.find_spec('cv2'), 'real OpenCV required for decoder budget proof')
class DecoderBudget(unittest.TestCase):
    def test_oversize_compressed_image_rejected_before_inference_and_worker_survives(self):
        bootstrap = '''
import runpy, sys, types
module = types.ModuleType('anime_face_detector')
def create_detector(**kwargs):
    def detect(arr):
        if arr.shape[0] * arr.shape[1] > 16777216:
            raise RuntimeError('oversized pixels reached inference')
        return []
    return detect
module.create_detector = create_detector
sys.modules['anime_face_detector'] = module
runpy.run_path(sys.argv[1], run_name='__main__')
'''
        images = [png(4097, 4096), png(9000, 1), png(1, 1)]
        request = ''.join(json.dumps({'id': i, 'b64': base64.b64encode(image).decode()}) + '\n' for i, image in enumerate(images))
        # Ambient settings cannot raise the service's own decoded-image budget.
        env = {**os.environ, 'OPENCV_IO_MAX_IMAGE_PIXELS': str(1 << 30)}
        result = subprocess.run([sys.executable, '-c', bootstrap, str(HERE / 'detect_worker.py')],
                                input=request, text=True, capture_output=True, timeout=15, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        ready, large, wide, small = map(json.loads, result.stdout.splitlines())
        self.assertTrue(ready['ready'])
        self.assertIn('error', large)
        self.assertNotIn('reached inference', large['error'])
        self.assertIn('MAX_IMAGE_PIXELS', large['error'])
        self.assertEqual(wide, {'id': 1, 'w': 9000, 'h': 1, 'faces': []})
        self.assertEqual(small, {'id': 2, 'w': 1, 'h': 1, 'faces': []})


if __name__ == '__main__':
    unittest.main()
