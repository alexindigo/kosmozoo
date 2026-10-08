"""Install this repository's coherent managed verifier without replacing custom hooks."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

from snapshot import VerificationError, git, require

MARKER = "# kosmozoo-full-project-pre-commit-v1"
SHIM = '''#!/usr/bin/env bash
# kosmozoo-full-project-pre-commit-v1
set -euo pipefail
HOOK_DIR="$(dirname "$(realpath "$0")")"
exec python3 -B "$HOOK_DIR/../kosmozoo-verification/current/controller.py" \\
  --config "$HOOK_DIR/../kosmozoo-verification/config.json"
'''


def install(repo, config, tools=None, expected_config=None):
    repo = Path(repo)
    custom = subprocess.run(["git", "-C", str(repo), "config", "--get", "core.hooksPath"], capture_output=True, text=True)
    require(custom.returncode == 1, "Existing core.hooksPath requires explicit integration; nothing changed")
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").decode().strip())
    hook = common / "hooks" / "pre-commit"
    if hook.exists() or hook.is_symlink():
        require(not hook.is_symlink() and hook.is_file() and MARKER in hook.read_text(), "Existing active pre-commit hook preserved; explicit integration required")
    root = common / "kosmozoo-verification"
    root.mkdir(mode=0o700, exist_ok=True)
    if (root / "config.json").exists():
        existing = json.loads((root / "config.json").read_text())
        require(existing == config or (expected_config is not None and existing == expected_config),
                "Installed verification config differs; explicit update required")
        if existing != config:
            backup = root / ("config-before-" + uuid.uuid4().hex + ".json")
            backup.write_text(json.dumps(existing, indent=2))
            backup.chmod(0o600)
    bundle = root / ("bundle-" + uuid.uuid4().hex)
    bundle.mkdir(mode=0o700)
    tools = Path(tools or __file__).parent if tools is None else Path(tools)
    for name in ["controller.py", "snapshot.py", "guest.py", "lifecycle.py"]:
        shutil.copyfile(tools / name, bundle / name)
        (bundle / name).chmod(0o600)
    pointer = root / ("current-" + uuid.uuid4().hex)
    pointer.symlink_to(bundle.name)
    os.replace(pointer, root / "current")
    cfg = root / ("config-" + uuid.uuid4().hex)
    cfg.write_text(json.dumps(config, indent=2))
    cfg.chmod(0o600)
    os.replace(cfg, root / "config.json")
    hook.parent.mkdir(parents=True, exist_ok=True)
    pending = hook.parent / ("pre-commit-" + uuid.uuid4().hex)
    pending.write_text(SHIM)
    pending.chmod(0o755)
    os.replace(pending, hook)
    return hook


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=str(Path.cwd()))
    parser.add_argument("--config", help="Explicit fresh-base configuration JSON")
    parser.add_argument("--expected-config", help="Exact installed managed config authorized for migration")
    parser.add_argument("--profile")
    parser.add_argument("--domain")
    parser.add_argument("--vm-uuid")
    parser.add_argument("--guest-root")
    parser.add_argument("--evidence-root", default=str(Path.home() / ".local/state/kosmozoo/pre-commit"))
    args = parser.parse_args()
    if args.config:
        from controller import load_config
        config = load_config(args.config)
        require(config["transport"] == "fresh-vm", "Installation config must use fresh invocation VMs")
    else:
        require(all([args.profile, args.domain, args.vm_uuid, args.guest_root]), "Guest identity/config required")
        uuid.UUID(args.vm_uuid)
        config = {"version": 1, "transport": "vm-transfer", "profile": args.profile, "domain": args.domain,
                  "vm_uuid": args.vm_uuid, "guest_root": args.guest_root, "evidence_root": args.evidence_root,
                  "vm_transfer_tool": str(Path.home() / "bin/vm-transfer"),
                  "vm_transfer_module": str(Path.home() / ".config/opencode/skills/virsh-vm-shell/scripts/vm_transfer.py")}
    expected = json.loads(Path(args.expected_config).read_text()) if args.expected_config else None
    print("Installed managed full-project hook: " + str(install(args.repo, config, expected_config=expected)))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (VerificationError, OSError, ValueError, subprocess.SubprocessError) as error:
        print("pre-commit installer: " + str(error), file=sys.stderr)
        sys.exit(1)
