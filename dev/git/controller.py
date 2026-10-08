"""Host Git/copy/transport controller. Every project workload belongs to the VM."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import uuid

from lifecycle import Invocation

from snapshot import VerificationError, export, git, require


def load_config(path):
    path = Path(path)
    require(path.is_file() and path.stat().st_uid == os.getuid() and not path.stat().st_mode & 0o022,
            "Verification config must be owned by this user and not group/world writable")
    config = json.loads(path.read_text())
    require(config.get("version") == 1, "Unsupported verification config")
    require(config.get("transport") in ("fresh-vm", "vm-transfer", "guest-local"), "No supported VM transport configured")
    for key in ["guest_root", "evidence_root"]:
        require(Path(config[key]).is_absolute(), key + " must be absolute")
    uuid.UUID(config["base"]["uuid"] if config["transport"] == "fresh-vm" else config["vm_uuid"])
    return config


def transfer_module(config):
    spec = importlib.util.spec_from_file_location("kosmozoo_vm_transfer", config["vm_transfer_module"])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RemoteVM:
    def __init__(self, config):
        self.config = config
        self.transfer = transfer_module(config)
        self.profile = self.transfer.load_profile(config["profile"])
        require(self.profile["guest"]["domain"] == config["domain"] and self.profile["guest"]["uuid"] == config["vm_uuid"],
                "Profile targets a different named VM")
        self.ip = self.transfer.discover(self.profile)
        self.transfer.probe_guest(self.profile, self.ip)
        self.argv = self.transfer.guest_argv(self.profile) + [self.profile["guest"]["user"] + "@" + self.ip]

    def command(self, args, **kwargs):
        return subprocess.run(self.argv + [shlex.join(args)], **kwargs)

    def send(self, bundle, attempt):
        remote = str(Path(self.config["guest_root"]) / "incoming" / attempt)
        code = ("import os,pathlib,sys;root=pathlib.Path(sys.argv[1]);p=pathlib.Path(sys.argv[2]);"
                "assert root.is_dir() and not root.is_symlink() and root.stat().st_uid==os.getuid();"
                "assert p.parent==root/'incoming' and p.parent.is_dir() and not p.exists();p.mkdir(mode=0o700)")
        self.command(["python", "-c", code, self.config["guest_root"], remote], check=True, timeout=60)
        subprocess.run([self.config["vm_transfer_tool"], "push", "--profile", self.config["profile"], "--apply",
                        str(bundle) + "/", remote + "/"], check=True, timeout=180)
        subprocess.run([self.config["vm_transfer_tool"], "verify", "--profile", self.config["profile"], "--direction", "push",
                        str(bundle) + "/", remote + "/"], check=True, timeout=180)
        return remote

    def run(self, remote, log):
        with Path(log).open("wb") as output:
            status = self.command(["python", "-B", str(Path(remote) / "guest.py"), remote,
                                   self.config["guest_root"], self.config["vm_uuid"]], stdout=output,
                                  stderr=subprocess.STDOUT, timeout=3600).returncode
        return status

    def collect(self, attempt, evidence):
        selection = Path(evidence).parent / "evidence-files.txt"
        selection.write_text("result.json\nmanifest.json\ninfrastructure.log\nunit.log\nbuild.log\nbrowser.log\n")
        remote = str(Path(self.config["guest_root"]) / "runs" / attempt)
        # A failed early run may not have all phase files; collect only existing known files.
        code = "import pathlib,sys,json;p=pathlib.Path(sys.argv[1]);print(json.dumps([n for n in ['result.json','manifest.json','infrastructure.log','unit.log','build.log','browser.log'] if (p/n).is_file()]))"
        result = self.command(["python", "-c", code, remote], capture_output=True, text=True, check=True, timeout=60)
        names = json.loads(result.stdout)
        require("result.json" in names, "Guest returned no verification result")
        selection.write_text("\n".join(names) + "\n")
        Path(evidence).mkdir(mode=0o700)
        subprocess.run([self.config["vm_transfer_tool"], "pull", "--profile", self.config["profile"], "--apply",
                        "--files-from", str(selection), remote + "/", str(evidence) + "/"], check=True, timeout=180)


class GuestLocalVM:
    """Integration route inside this exact VM, never an SSH failure fallback."""
    def __init__(self, config):
        from guest import guard
        guard(config["guest_root"], config["vm_uuid"])
        self.config = config

    def send(self, bundle, attempt):
        destination = Path(self.config["guest_root"]) / "incoming" / attempt
        require(not destination.exists(), "Fixture incoming attempt already exists")
        shutil.copytree(bundle, destination)
        return str(destination)

    def run(self, remote, log):
        with Path(log).open("wb") as output:
            return subprocess.run([sys.executable, "-B", str(Path(remote) / "guest.py"), remote,
                                   self.config["guest_root"], self.config["vm_uuid"]], stdout=output,
                                  stderr=subprocess.STDOUT, timeout=3600).returncode

    def collect(self, attempt, evidence):
        origin = Path(self.config["guest_root"]) / "runs" / attempt
        require((origin / "result.json").is_file(), "Guest returned no verification result")
        Path(evidence).mkdir(mode=0o700)
        for name in ["result.json", "manifest.json", "infrastructure.log", "unit.log", "build.log", "browser.log"]:
            if (origin / name).is_file():
                shutil.copyfile(origin / name, Path(evidence) / name)


def verify(config_path, repo=None, transport_factory=None):
    config = load_config(config_path)
    repo = Path(repo or git(Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())
    root = Path(config["evidence_root"])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not root.is_symlink() and root.stat().st_uid == os.getuid(), "Evidence directory ownership mismatch")
    attempt = "run-" + uuid.uuid4().hex
    run = root / attempt
    run.mkdir(mode=0o700)
    manifest = export(repo, run / "bundle")
    for name in ["snapshot.py", "guest.py"]:
        shutil.copyfile(Path(__file__).with_name(name), run / "bundle" / name)
    receipt = {"version": 1, "attempt": attempt, "tree": manifest["tree"], "success": False}
    invocation = None
    previous_signal = signal.getsignal(signal.SIGTERM)
    def interrupted(signum, frame):
        raise VerificationError("Invocation interrupted by SIGTERM")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        active = config
        if config["transport"] == "fresh-vm" and transport_factory is None:
            invocation = Invocation(config, transfer_module(config), run)
            active = invocation.prepare()
        factory = transport_factory or (GuestLocalVM if config["transport"] == "guest-local" else RemoteVM)
        transport = factory(active)
        remote = transport.send(run / "bundle", attempt)
        status = transport.run(remote, run / "guest-command.log")
        transport.collect(attempt, run / "evidence")
        result = json.loads((run / "evidence" / "result.json").read_text())
        require(result.get("attempt") == attempt, "Guest result does not match this attempt")
        require(status == 0 and result.get("success") is True, result.get("error", "Full VM verification failed"))
        require(result.get("tree") == manifest["tree"], "Guest result does not match this staged tree")
        observed_manifest = json.loads((run / "evidence" / "manifest.json").read_text())
        require(observed_manifest == manifest, "Guest manifest does not match complete staged inputs")
        phases = {phase["name"]: phase["status"] for phase in result.get("phases", [])}
        required = ["unit", "build", "browser"]
        if any(item["path"].startswith("dev/git/tests/") for item in manifest["files"]):
            required.append("infrastructure")
        require(all(phases.get(name) == 0 for name in required), "Incomplete full-project result")
        require(git(repo, "write-tree").decode().strip() == manifest["tree"], "Staged files changed while tests ran; commit again to verify the new tree")
        if invocation:
            invocation.retire()
        require(git(repo, "write-tree").decode().strip() == manifest["tree"], "Staged files changed during lifecycle completion")
        receipt["success"] = True
        print("pre-commit: full staged project passed: " + manifest["tree"])
    except (Exception, KeyboardInterrupt) as error:
        receipt["error"] = str(error)
        if invocation:
            invocation.retain(error)
        print("pre-commit: " + str(error), file=sys.stderr)
    finally:
        signal.signal(signal.SIGTERM, previous_signal)
        (run / "receipt.json").write_text(json.dumps(receipt, indent=2))
        print("pre-commit: retained evidence: " + str(run), flush=True)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    return 0 if verify(args.config)["success"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VerificationError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("pre-commit: " + str(error), file=sys.stderr)
        sys.exit(1)
