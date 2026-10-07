"""Dedicated VM runner: full project checks for one independently read-back tree."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time

from snapshot import VerificationError, check_inputs, materialize, require

ADAPTER_SHA = "d8f1253043e7131f3c3d9e5e4f821902f93387d8dfbcae0f9c27e5caaf6de435"
IMAGES = {"docker.io/denoland/deno:latest": "sha256:fa335acdf6b72106eda2cb6a8cb5f4187e7630e357467489db4b2e7352d5e432",
          "mcr.microsoft.com/playwright:v1.49.1-noble": "sha256:70e367e0cbf60340a5b5fd562f6247a34eb3196efab9f88a3dd56482d9fe09d2"}
NAMES = ["kz-precommit-unit", "kz-precommit-build", "kz-e2e-fake", "kz-e2e-fake2", "kz-e2e-engine"] + [
    "kz-e2e-feed-resize-" + suite for suite in ["workbench", "variations", "diff", "cache", "feed"]]


def vm_identity():
    require(subprocess.run(["systemd-detect-virt", "--vm"], stdout=subprocess.DEVNULL).returncode == 0,
            "Project verification must run inside a virtual machine")
    path = Path("/sys/class/dmi/id/product_uuid")
    try:
        value = path.read_text()
    except PermissionError:
        # The prepared guest exposes UUID as root:root 0400; this exact read
        # uses its documented non-interactive VM sudo access, without mutation.
        value = subprocess.check_output(["sudo", "-n", "/usr/bin/cat", str(path)], text=True)
    return value.strip().lower()


def guard(root, expected_uuid):
    require(vm_identity() == expected_uuid.lower(), "Command does not target the configured virtual machine")
    root = Path(root)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), "Missing/private disk-backed guest workspace")
    require(root.stat().st_uid == os.getuid(), "Guest workspace ownership mismatch")
    mount = json.loads(subprocess.check_output(["findmnt", "-J", "-o", "TARGET,FSTYPE,OPTIONS", "-T", str(root)], text=True))["filesystems"][0]
    require(mount["fstype"] not in ("tmpfs", "ramfs") and "rw" in mount["options"].split(","), "Guest workspace is not disk-backed/writable")


def phases(source):
    source = Path(source)
    commands = []
    if (source / "dev/git/tests").is_dir():
        commands.append(("infrastructure", [sys.executable, "-B", "-m", "unittest", "discover", "-s", "dev/git/tests", "-v"]))
    commands += [
        ("unit", ["bash", "-o", "pipefail", "-c", 'docker run --rm --name kz-precommit-unit --network host -v "$PWD":/work -w /work docker.io/denoland/deno:latest test --allow-all tests/t_*.mjs']),
        ("build", ["docker", "run", "--rm", "--name", "kz-precommit-build", "--network", "host", "-v", str(source) + ":/work", "-w", "/work", "docker.io/denoland/deno:latest", "run", "--frozen", "--allow-all", "build.mjs"]),
        ("browser", ["bash", "/home/tester/kosmozoo-plan-tools/run-e2e-named.sh"]),
    ]
    return commands


def execute(command, source, log, env, timeout=1800):
    with Path(log).open("wb") as output:
        process = subprocess.Popen(command, cwd=source, env=env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return process.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, BaseException):
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise


def verify(bundle, root, expected_uuid, run_phase=execute):
    root, bundle = Path(root), Path(bundle)
    guard(root, expected_uuid)
    require(bundle.resolve().is_relative_to((root / "incoming").resolve()) and bundle.is_dir(), "Incoming attempt escapes workspace")
    attempt = bundle.name
    require(attempt and attempt.replace("-", "").isalnum(), "Invalid attempt ID")
    run = root / "runs" / attempt
    require(not run.exists(), "Attempt has already been executed; no green-result reuse")
    run.mkdir(mode=0o700, parents=True)
    result = {"version": 1, "attempt": attempt, "success": False, "phases": [], "tree": None}
    lock = None
    owned = False
    started = time.monotonic()
    try:
        lock = (root / "verification.lock").open("a+")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise VerificationError("Verification VM is busy; staged work is preserved") from error
        adapter = Path("/home/tester/kosmozoo-plan-tools/run-e2e-named.sh")
        require(hashlib.sha256(adapter.read_bytes()).hexdigest() == ADAPTER_SHA, "Approved browser adapter changed")
        for image, expected in IMAGES.items():
            actual = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
            require(actual == expected, "Prepared tool image changed: " + image)
        occupied = set(subprocess.check_output(["docker", "ps", "-a", "--format", "{{.Names}}"], text=True).splitlines()) & set(NAMES)
        require(not occupied, "Owned test container names are occupied: " + ", ".join(sorted(occupied)))
        for port in [18260, 18261, 18262]:
            with socket.socket() as probe:
                probe.settimeout(1)
                require(probe.connect_ex(("127.0.0.1", port)) != 0, f"Verification port {port} is occupied")
        owned = True
        source = run / "source"
        manifest = materialize(bundle, source)
        result["tree"] = manifest["tree"]
        (run / "manifest.json").write_text(json.dumps(manifest, indent=2))
        temporary = run / "tmp"
        temporary.mkdir(mode=0o700)
        env = dict(os.environ, TMPDIR=str(temporary))
        # A fixture's host Git environment must never leak into child test repositories.
        for key in list(env):
            if key.startswith("GIT_"):
                env.pop(key)
        for name, command in phases(source):
            print("pre-commit: running full " + name + " checks", flush=True)
            status = run_phase(command, source, run / (name + ".log"), env)
            result["phases"].append({"name": name, "status": status})
            require(status == 0, "Full " + name + " checks failed; see " + str(run / (name + ".log")))
        check_inputs(source, manifest)
        result["success"] = True
    except Exception as error:
        result["error"] = str(error)
    finally:
        if owned:
            # These names were absent before our exclusive lease; only this run may own them.
            existing = set(subprocess.check_output(["docker", "ps", "-a", "--format", "{{.Names}}"], text=True).splitlines()) & set(NAMES)
            if existing:
                cleaned = subprocess.run(["docker", "rm", "-f", *sorted(existing)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if cleaned.returncode:
                    result["success"] = False
                    result["cleanupError"] = cleaned.stderr.decode(errors="replace")
        if lock:
            lock.close()
        result["elapsedSeconds"] = time.monotonic() - started
        (run / "result.json").write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bundle")
    parser.add_argument("root")
    parser.add_argument("vm_uuid")
    args = parser.parse_args()
    return 0 if verify(args.bundle, args.root, args.vm_uuid)["success"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VerificationError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("pre-commit: " + str(error), file=sys.stderr)
        sys.exit(1)
