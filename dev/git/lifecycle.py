"""Owned, evidence-backed invocation VMs; host code never runs project checks."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
import uuid
import xml.etree.ElementTree as ET

from snapshot import require


def identity(xml):
    root = ET.fromstring(xml)
    disks = root.findall("./devices/disk")
    interfaces = root.findall("./devices/interface")
    require(len(disks) == 1 and disks[0].get("type") == "file"
            and disks[0].get("device") == "disk"
            and disks[0].find("driver").get("type") == "qcow2"
            and disks[0].find("./backingStore/source") is None
            and not root.findall("./devices/filesystem"), "Unsupported VM storage layout")
    require(len(interfaces) == 1, "Ambiguous VM network identity")
    result = {"domain": root.findtext("name"), "uuid": root.findtext("uuid"),
              "mac": interfaces[0].find("mac").get("address").lower(),
              "disk": disks[0].find("source").get("file"),
              "nvram": root.findtext("./os/nvram")}
    uuid.UUID(result["uuid"])
    require(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", result["domain"]), "Invalid domain name")
    require(re.fullmatch(r"(?:[0-9a-f]{2}:){5}[0-9a-f]{2}", result["mac"]), "Invalid domain MAC")
    for key, parent in [("disk", "/var/lib/libvirt/images"), ("nvram", "/var/lib/libvirt/qemu/nvram")]:
        value = result[key]
        require(value and str(Path(value).parent) == parent and ".." not in Path(value).parts,
                "Unexpected private " + key + " path")
    return result


def assert_private(owned, base, domains):
    require(owned["domain"].startswith(base["domain"] + "-run-")
            and owned["uuid"] != base["uuid"] and owned["mac"] != base["mac"], "Not an invocation owned by this attempt")
    resources = {owned["disk"], owned["nvram"]}
    require(len(resources) == 2 and not resources & {base["disk"], base["nvram"]}, "Invocation shares base storage")
    for xml in domains:
        root = ET.fromstring(xml)
        if root.findtext("uuid") == owned["uuid"]:
            continue
        references = {node.get("file") or node.get("dev") for node in root.findall(".//disk//source")}
        references.add(root.findtext("./os/nvram"))
        require(not references & resources, "Invocation storage is referenced by another domain")


class Invocation:
    def __init__(self, config, transfer, run):
        self.config, self.transfer, self.run = config, transfer, Path(run)
        self.base_profile = transfer.load_profile(config["base_profile"])
        self.base = config["base"]
        require(all(self.base_profile["guest"][k] == self.base[k] for k in ["domain", "uuid", "mac"]),
                "Prepared base profile identity differs")
        self.domain = self.base["domain"] + "-" + self.run.name
        self.record = {"attempt": self.run.name, "domain": self.domain, "status": "planned", "base": self.base}
        self.persist()

    def persist(self):
        pending = self.run / "lifecycle.pending"
        pending.write_text(json.dumps(self.record, indent=2))
        pending.chmod(0o600)
        os.replace(pending, self.run / "lifecycle.json")

    def host(self, args, check=True, timeout=60):
        result = subprocess.run(self.transfer.host_argv(self.base_profile) + [shlex.join(args)],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
        with (self.run / "lifecycle.log").open("a") as output:
            output.write(shlex.join(args) + "\n" + result.stdout + result.stderr)
        if check:
            require(result.returncode == 0, "Ark lifecycle command failed: " + result.stderr.strip())
        return result

    def virsh(self, *args, **kwargs):
        return self.host(["virsh", "-c", "qemu:///system", *args], **kwargs)

    def inventory(self):
        names = self.virsh("list", "--all", "--name").stdout.splitlines()
        return [self.virsh("dumpxml", name, "--inactive").stdout for name in names if name.strip()]

    def wait(self, query, description, seconds=180):
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            try:
                value = query()
                if value:
                    return value
            except (Exception,) as error:
                last = error
            time.sleep(2)
        require(False, description + " deadline exceeded" + (": " + str(last) if last else ""))

    def base_guard(self):
        observed = identity(self.virsh("dumpxml", self.base["domain"], "--inactive").stdout)
        require(observed == self.base, "Prepared base identity/storage changed")
        require(self.virsh("domstate", self.base["uuid"]).stdout.strip() == "shut off", "Prepared base must stay shut off")
        checkpoint = self.virsh("snapshot-dumpxml", self.base["uuid"], self.config["snapshot"]).stdout
        require(hashlib.sha256(checkpoint.encode()).hexdigest() == self.config["snapshot_sha256"], "Prepared checkpoint changed")
        xml = ET.fromstring(checkpoint)
        require(xml.findtext("state") == "shutoff" and xml.findtext("domain/uuid") == self.base["uuid"],
                "Prepared checkpoint is not the approved offline base")
        info = json.loads(self.host(["sudo", "-n", "qemu-img", "info", "--output=json", self.base["disk"]]).stdout)
        selected = [item for item in info.get("snapshots", []) if item.get("name") == self.config["snapshot"]]
        require(len(selected) == 1, "Physical checkpoint selector is absent or ambiguous")
        require(selected[0] == self.config["disk_snapshot"], "Physical checkpoint identity changed")
        require(self.virsh("dominfo", self.domain, check=False).returncode != 0, "Invocation destination already exists")
        require(not any(ET.fromstring(x).findtext("name") == self.domain for x in self.inventory()), "Invocation collision")

    def key(self):
        command = {"execute": "guest-exec", "arguments": {"path": "/usr/bin/cat",
                   "arg": ["/etc/ssh/ssh_host_ed25519_key.pub"], "capture-output": True}}
        pid = json.loads(self.virsh("qemu-agent-command", self.record["owned"]["uuid"], json.dumps(command)).stdout)["return"]["pid"]
        def result():
            args = {"execute": "guest-exec-status", "arguments": {"pid": pid}}
            data = json.loads(self.virsh("qemu-agent-command", self.record["owned"]["uuid"], json.dumps(args)).stdout)["return"]
            if not data.get("exited"):
                return None
            require(data.get("exitcode") == 0 and not data.get("out-truncated"), "Cannot observe guest SSH key")
            key = " ".join(base64.b64decode(data["out-data"], validate=True).decode().split()[:2])
            require(key == self.config["guest_host_key"], "Invocation SSH key differs from approved base")
            return key
        return self.wait(result, "Guest public key", seconds=30)

    def prepare(self):
        self.base_guard()
        helper = Path(self.config["fork_tool"])
        require(hashlib.sha256(helper.read_bytes()).hexdigest() == self.config["fork_sha256"], "Approved fork helper changed")
        self.record["status"] = "creating"
        self.persist()
        # The helper manages libvirt/storage only; no project workloads execute here.
        with (self.run / "fork.log").open("wb") as output:
            result = subprocess.run([str(helper), self.base["domain"], "run", self.run.name.removeprefix("run-"),
                                     self.config["snapshot"]], stdout=output, stderr=subprocess.STDOUT, timeout=300)
        self.record["fork_exit"] = result.returncode
        xml = self.virsh("dumpxml", self.domain, "--inactive").stdout
        self.record["owned"] = identity(xml)
        self.persist()
        (self.run / "domain.xml").write_text(xml)
        owned = self.record["owned"]
        require(owned["domain"] == self.domain, "Created a different invocation domain")
        assert_private(owned, self.base, self.inventory())
        # A running fork proves the helper passed its copy/snapshot/start gates.
        # The documented empty-IP pipeline may have exited after those gates.
        require(self.virsh("domstate", owned["uuid"]).stdout.strip() == "running", "Fork did not reach running state; partial VM retained")
        log = (self.run / "fork.log").read_text()
        require("reflink " + self.base["disk"] + " → " + owned["disk"] in log
                and "applying snapshot '" + self.config["snapshot"] + "'" in log, "Fork storage/checkpoint provenance missing")
        provisional = json.loads(json.dumps(self.base_profile))
        provisional["guest"].update({k: owned[k] for k in ["domain", "uuid", "mac"]})
        self.wait(lambda: self.transfer.discover(provisional), "Invocation agent/address")
        key = self.key()
        trust = self.run / "known_hosts"
        host = provisional["host"]["hostname"]
        trust.write_text(host + " " + self.config["host_key"] + "\n" + self.domain + " " + key + "\n")
        trust.chmod(0o600)
        provisional["host"]["known_hosts"] = str(trust)
        provisional["guest"]["known_hosts"] = str(trust)
        profile = self.run / "profile.json"
        profile.write_text(json.dumps(provisional, indent=2))
        profile.chmod(0o600)
        self.record.update(status="ready", profile=str(profile))
        self.persist()
        return {**self.config, "profile": str(profile), "domain": self.domain, "vm_uuid": owned["uuid"]}

    def retire(self):
        owned = self.record["owned"]
        def guard():
            require(identity(self.virsh("dumpxml", owned["uuid"], "--inactive").stdout) == owned,
                    "Invocation identity/storage changed before cleanup")
            assert_private(owned, self.base, self.inventory())
        guard()
        self.record["status"] = "stopping"
        self.persist()
        self.virsh("shutdown", owned["uuid"])
        self.wait(lambda: self.virsh("domstate", owned["uuid"]).stdout.strip() == "shut off", "Invocation shutdown", seconds=90)
        guard()
        self.record["status"] = "removing"
        self.persist()
        self.virsh("undefine", owned["uuid"], "--nvram", "--snapshots-metadata", "--remove-all-storage")
        require(self.virsh("dominfo", owned["uuid"], check=False).returncode != 0, "Invocation domain still exists")
        # Read exact recorded paths on Ark; do not infer storage names or delete again.
        probe = "import os,sys; assert all(not os.path.lexists(p) for p in sys.argv[1:]), 'Owned storage remains'"
        self.host(["python", "-c", probe, owned["disk"], owned["nvram"]])
        self.record["status"] = "removed"
        self.persist()

    def retain(self, error):
        if self.record["status"] == "creating" and "owned" not in self.record:
            try:
                result = self.virsh("dumpxml", self.domain, "--inactive", check=False)
                if result.returncode == 0:
                    (self.run / "domain.xml").write_text(result.stdout)
                    self.record["owned"] = identity(result.stdout)
            except Exception as capture_error:
                self.record["identity_capture_error"] = str(capture_error)
        retained = self.record["status"] != "removed"
        self.record.update(error=str(error), retained=retained)
        self.persist()
        label = "retained" if retained else "already removed; index changed afterward"
        print("pre-commit: failed/interrupted invocation " + label + ": " + self.domain, flush=True)
