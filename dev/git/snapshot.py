"""Complete staged Git-tree export; source bytes never come from working files."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import tarfile


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def git(repo, *args, input=None):
    result = subprocess.run(["git", "-C", str(repo), *args], input=input,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, result.stderr.decode(errors="replace").strip())
    return result.stdout


def safe_path(name):
    require(isinstance(name, str) and name and not name.startswith("/")
            and "\\" not in name and all(p not in ("", ".", "..", ".git") for p in name.split("/"))
            and not any(ord(c) < 32 or ord(c) == 127 for c in name), f"Unsafe snapshot path: {name!r}")
    return name


def object_id(kind, data):
    return hashlib.sha1(f"{kind} {len(data)}\0".encode() + data).hexdigest()


def tree_id(files):
    root = {}
    for item in files:
        parts = item["path"].split("/")
        node = root
        for part in parts[:-1]:
            existing = node.setdefault(part, {})
            require(isinstance(existing, dict), "File/directory snapshot collision")
            node = existing
        require(parts[-1] not in node, "Duplicate/file-directory snapshot collision")
        node[parts[-1]] = (item["mode"], item["oid"])

    def encode(node):
        entries = []
        for name, value in node.items():
            directory = isinstance(value, dict)
            mode, oid = ("40000", encode(value)) if directory else value
            entries.append((name.encode() + (b"/" if directory else b""),
                            mode.encode() + b" " + name.encode() + b"\0" + bytes.fromhex(oid)))
        return object_id("tree", b"".join(payload for _, payload in sorted(entries)))
    return encode(root)


def validate_manifest(manifest):
    require(manifest.get("version") == 1 and manifest.get("objectFormat") == "sha1", "Unsupported snapshot format")
    require(re.fullmatch(r"[0-9a-f]{40}", manifest.get("tree", "")), "Invalid snapshot tree ID")
    seen = set()
    for item in manifest.get("files", []):
        name = safe_path(item["path"])
        require(name not in seen, "Duplicate snapshot path")
        seen.add(name)
        require(item["mode"] in ("100644", "100755", "120000"), f"Unsupported Git mode: {name}")
        require(re.fullmatch(r"[0-9a-f]{40}", item["oid"]), "Invalid blob ID")
        require(re.fullmatch(r"[0-9a-f]{64}", item["sha256"]), "Invalid byte checksum")
    require(tree_id(manifest["files"]) == manifest["tree"], "Manifest does not represent its claimed Git tree")


def export(repo, destination):
    destination = Path(destination)
    require(not destination.exists(), "Snapshot destination already exists")
    require(git(repo, "rev-parse", "--show-object-format").strip() == b"sha1", "Unsupported Git object format")
    tree = git(repo, "write-tree").decode().strip()  # honors Git's active GIT_INDEX_FILE
    files = []
    payloads = {}
    for record in git(repo, "ls-tree", "-rz", "--full-tree", tree).split(b"\0"):
        if not record:
            continue
        metadata, raw_name = record.split(b"\t", 1)
        mode, kind, oid = metadata.decode().split()
        name = safe_path(raw_name.decode())
        require(kind == "blob" and mode in ("100644", "100755", "120000"),
                f"Cannot verify staged Git object {name} ({mode}/{kind})")
        data = git(repo, "cat-file", "blob", oid)
        payloads[name] = data
        files.append({"path": name, "mode": mode, "oid": oid,
                      "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})
    manifest = {"version": 1, "objectFormat": "sha1", "tree": tree, "files": files}
    validate_manifest(manifest)
    destination.mkdir(mode=0o700)
    with tarfile.open(destination / "source.tar", "w") as archive:
        for item in files:
            data = payloads[item["path"]]
            member = tarfile.TarInfo(item["path"])
            member.mode = 0o755 if item["mode"] == "100755" else 0o644
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))  # links are explicit blob bytes, not tar link operations
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def check_inputs(root, manifest):
    root = Path(root)
    for item in manifest["files"]:
        path = root / item["path"]
        if item["mode"] == "120000":
            require(path.is_symlink(), f"Snapshot link mode changed: {item['path']}")
            data = os.readlink(path).encode()
            require(path.resolve().is_relative_to(root.resolve()), "Snapshot link escapes source")
        else:
            require(path.is_file() and not path.is_symlink(), f"Snapshot file missing: {item['path']}")
            mode = "100755" if path.stat().st_mode & 0o111 else "100644"
            require(mode == item["mode"], f"Snapshot executable mode changed: {item['path']}")
            data = path.read_bytes()
        require(object_id("blob", data) == item["oid"] and hashlib.sha256(data).hexdigest() == item["sha256"],
                f"Snapshot input changed: {item['path']}")


def materialize(bundle, source):
    bundle, source = Path(bundle), Path(source)
    require(not source.exists(), "Guest source destination already exists")
    manifest = json.loads((bundle / "manifest.json").read_text())
    validate_manifest(manifest)
    expected = {item["path"]: item for item in manifest["files"]}
    payloads = {}
    with tarfile.open(bundle / "source.tar", "r:") as archive:
        for member in archive.getmembers():
            name = safe_path(member.name)
            require(member.isfile() and name in expected and name not in payloads, "Unexpected/duplicate archive member")
            payload = archive.extractfile(member).read()
            item = expected[name]
            require(len(payload) == item["bytes"] and object_id("blob", payload) == item["oid"]
                    and hashlib.sha256(payload).hexdigest() == item["sha256"], "Archive byte/blob mismatch")
            payloads[name] = payload
    require(set(payloads) == set(expected), "Incomplete staged source archive")
    for name, item in expected.items():
        if item["mode"] == "120000":
            target = payloads[name].decode()
            resolved = posixpath.normpath(posixpath.join(str(PurePosixPath(name).parent), target))
            require(not target.startswith("/") and resolved != ".." and not resolved.startswith("../"), "Escaping staged symlink")
    source.mkdir(mode=0o700)
    for name, item in expected.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if item["mode"] != "120000":
            path.write_bytes(payloads[name])
            path.chmod(0o755 if item["mode"] == "100755" else 0o644)
    for name, item in expected.items():
        if item["mode"] == "120000":
            (source / name).symlink_to(payloads[name].decode())
    check_inputs(source, manifest)
    return manifest
