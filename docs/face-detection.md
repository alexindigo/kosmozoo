# Optional face detector

Kosmozoo's supplied detector is a separate Python HTTP service using
[anime-face-detector](https://github.com/hysts/anime-face-detector). It detects
near-frontal anime faces and 28 landmarks for geometric comparison. It is not
universal person detection or identity recognition. The worker always uses CPU,
even if a CUDA-enabled PyTorch is installed.

Neither the [native executable](executable.md) nor the [engine Docker image](container.md)
bundles Python, this service or model weights. Installing and running the service
is separate from saving its URL in Kosmozoo and enabling detection in the viewer.
Kosmozoo does not start, supervise or stop the external process.

## Install on the engine computer

The tested baseline is Linux x86_64, Python 3.12.16, anime-face-detector 0.1.0,
PyTorch 2.15.0+cpu and torchvision 0.29.2+cpu. Have Python 3.12 with `venv`/`pip`
and `curl` installed first. Python downloads are at [python.org](https://www.python.org/downloads/).
Upstream requires Python 3.12 or later; the commands below use the tested 3.12
interpreter explicitly.

| # | Download / reference | Purpose |
|---|---|---|
| 1 | [Upstream installation instructions](https://github.com/hysts/anime-face-detector#installation) and [PyPI 0.1.0](https://pypi.org/project/anime-face-detector/0.1.0/) | Python package; version 0.1.0 uses plain PyTorch, without an OpenMMLab runtime. |
| 2 | [Official PyTorch installation](https://pytorch.org/get-started/locally/) | CPU wheel index used below. |
| 3 | [detect_service.py](https://raw.githubusercontent.com/alexindigo/kosmozoo/v0.4.0/plugins/detector/detect_service.py) and [detect_worker.py](https://raw.githubusercontent.com/alexindigo/kosmozoo/v0.4.0/plugins/detector/detect_worker.py) | Kosmozoo v0.4.0 HTTP wrapper and worker; keep both files side by side. |

Create a user-local environment and download both scripts. This works with the
binary distribution: no Deno installation or Git checkout is needed.

```sh
mkdir -p "$HOME/.local/share/kosmozoo-detector"
cd "$HOME/.local/share/kosmozoo-detector"
python3.12 -m venv .venv
.venv/bin/python -m pip install 'torch==2.15.0+cpu' 'torchvision==0.29.2+cpu' --index-url https://download.pytorch.org/whl/cpu
.venv/bin/python -m pip install 'anime-face-detector==0.1.0'
curl --fail --location --max-time 60 -o detect_service.py https://raw.githubusercontent.com/alexindigo/kosmozoo/v0.4.0/plugins/detector/detect_service.py
curl --fail --location --max-time 60 -o detect_worker.py https://raw.githubusercontent.com/alexindigo/kosmozoo/v0.4.0/plugins/detector/detect_worker.py
```

If using a v0.4.0 source checkout instead, its `plugins/detector/` directory
already contains both scripts. Use the environment's Python to run that copy.

## Download the models before starting the service

Run this once in the same account and environment that will run the service:

```sh
cd "$HOME/.local/share/kosmozoo-detector"
.venv/bin/python -c 'from anime_face_detector import create_detector; create_detector(device="cpu"); print("Models cached")'
```

Wait for `Models cached` and a successful exit. This downloads and loads the
default [YOLOv3 face detector](https://huggingface.co/hysts/anime-face-detector-yolov3)
and [HRNetV2 landmark model](https://huggingface.co/hysts/anime-face-detector-hrnetv2)
as safetensors. No manual `.pth` download or conversion is needed.

With the default environment, Hugging Face stores them under
`~/.cache/huggingface/hub`. Keep that cache for later launches. If provisioning
was interrupted, rerun the prefetch command successfully before launching the
worker. Use the same account and cache for prefetch and service launch.

For offline use after successful prefetch, explicitly set `HF_HUB_OFFLINE=1`
as shown below. This cached launch was verified with networking disabled.
The worker also has an automatic offline check under the hard-coded
`~/.cache/huggingface` path, but its
name-matching heuristic does not trigger with the tested Hub cache layout. Do
not rely on it to prevent network requests or prove that both models are cached.
A custom Hugging Face cache environment does not relocate that worker check;
these instructions use the default cache location.

The HTTP wrapper waits only 60 seconds for its worker's ready handshake. First
downloads can exceed that, so prefetch outside the wrapper instead of relying on
its first launch. If startup already timed out, finish prefetch, stop that
foreground service, then launch it again. Late downloads do not update the
wrapper's missed handshake automatically.

## Run and check readiness

Keep this running in a terminal on the engine computer:

```sh
cd "$HOME/.local/share/kosmozoo-detector"
.venv/bin/python detect_service.py 8471
```

It binds only `127.0.0.1:8471`. Leave the terminal open; stop it with Ctrl+C.
For an offline launch with the complete cache, use this launch command instead:

```sh
HF_HUB_OFFLINE=1 .venv/bin/python detect_service.py 8471
```

From another terminal on that same computer, check:

```sh
curl --fail --max-time 5 http://127.0.0.1:8471/health
```

Expect HTTP 200 with these fields (`stderr_tail` may also contain diagnostics):

```json
{"model_ready":true,"model":"anime-face-detector","deadline_ms":60000,"stderr_tail":[]}
```

The listener starts after the initial handshake wait, so a connection refusal
early in startup is possible. HTTP 200 alone is insufficient: confirm
`model_ready` is `true`. Health proves model readiness, not that a particular
image contains a face.

## Connect in the Web UI

The saved URL is resolved by the **Kosmozoo engine**, not by the browser. If the
browser and engine are on different computers, the browser's localhost is not
the engine computer.

| # | Engine topology | Service URL / scope |
|---|---|---|
| 1 | Native Linux engine and detector on the same computer | Use `http://127.0.0.1:8471`. |
| 2 | Linux engine container using host networking, detector on that same host | The same loopback URL works because they share the host network namespace. |
| 3 | Bridge-networked engine container | Its loopback belongs to the container. The host-loopback-only detector is not reachable through a `host.docker.internal` alias. This guide covers the same-host native or host-networked topology; see [container networking](container.md#folder-collections) for the container address boundary. |

The supplied service has no authentication and listens on loopback. These steps
do not require changing its binding or exposing it to a network.

| # | Web UI step | Expected result |
|---|---|---|
| 1 | Open Settings/Options, find **Face detector service**, enter the engine-reachable base URL, then **Save**. Do not append `/health` or `/detect`. | `Detector settings saved`; the URL persists in `plugins.detector.serviceUrl`. Saving alone does not check health. |
| 2 | Open a still-image pair and choose a comparison view, such as Two-Up. | Detection controls appear; Full, unpaired, video and audio views are not eligible. |
| 3 | Turn **Face detection** on. | Readiness is checked and the two images are detected. It starts OFF on every fresh page load, independently of the saved URL. |
| 4 | Select **Face-anchored** alignment and choose each image's face anchor as needed. Double-click a face or use its A1/B1-style face button. | One usable face can anchor directly; multiple faces require an explicit choice. All detected faces remain selected. |

Selecting Face-anchored does not turn detection on. Independent/Shared alignment
can show face boxes while detection is on. Face-anchored additionally matches eye
midpoint and scale, without rotation. Turning detection off hides its feedback
and alignment effect while retaining choices for the current page session; it
does not stop the external service.

## Interpret connection and detection states

| # | State | Meaning / next check |
|---|---|---|
| 1 | Unconfigured / `Set a detector service URL` | No URL is saved. Enter and save it in Settings/Options. |
| 2 | Unreachable / `Detector service unavailable` | The engine could not obtain valid health. Check the foreground process, its `/health` response and the engine's network namespace. |
| 3 | Loading / `Detector model is loading` | Health answered but `model_ready` is false. Inspect `stderr_tail` and the service terminal; a missed initial handshake needs the prefetch/relaunch sequence above. |
| 4 | `No faces detected` | A successful result contained `faces:[]`; this is not a missing service. The model is limited to near-frontal anime faces. |
| 5 | `Eye landmarks unavailable` / waiting for a face choice | Detection returned boxes, but alignment needs usable eyes and an anchor on each image. |

Use **Retry detection** after resolving a reported connection/detection failure.
Errors are not treated as no-face results. See the [detector specification](spec.md#detector-foundation)
for the engine's status and error contracts.

## API compatibility

There is no universal standardized face-landmark API implemented here. Kosmozoo
uses a custom HTTP contract; the supplied anime-face-detector service is one
implementation. Another library needs an adapter that supplies this contract:

| # | Backend endpoint | Contract |
|---|---|---|
| 1 | `GET /health` | JSON with `model_ready`, `model` and a finite positive `deadline_ms`; the engine uses that deadline plus a 5000 ms margin. The supplied service uses 60000 ms. |
| 2 | `POST /detect` | Raw image bytes (`application/octet-stream`), not JSON/base64. Return positive finite pixel dimensions `w`/`h` and `faces`, each with `bbox:[x0,y0,x1,y1]`, finite or null `score`, and `kps:[[x,y,confidence],...]`. Coordinates must be finite; box corners must increase. |

For example, a successful **no-face** response has this shape:

```json
{"w":512,"h":512,"faces":[],"id":1}
```

`id` is an optional safe integer. Landmark confidences need not be between 0 and
1. The engine validates the response and adds the accepted image hash/source
identity and detector identity; see the [full contract](spec.md#detector-foundation).
The health `model` value is a label, not a weights fingerprint.

The generic result codec accepts box-only results and arbitrary landmark counts.
The current Face-anchored consumer (`faceEyes`) specifically requires **exactly
28 landmarks in anime-face-detector order**: zero-based eye groups 11-16 and
17-22, whose centroids define the alignment. Box-only, 5-point and 68-point
detectors are not drop-in Face-anchored substitutes. Matching HTTP field names
alone is insufficient. There is no model picker, GPU switch or automatic service
discovery in this setup.
