import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS))
import controller
import guest
import install
import snapshot


def run(repo, *args, check=True):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if check and result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    return result


class VMCase(unittest.TestCase):
    def setUp(self):
        base = Path.home() / "kosmozoo-pre-commit" / "fixtures"
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.vm_uuid = guest.vm_identity()
        guest.guard(base, self.vm_uuid)
        self.root = Path(tempfile.mkdtemp(prefix="case-", dir=base))
        self.repo = self.root / "repo"
        self.repo.mkdir()
        run(self.repo, "init")
        self.key = self.root / "fixture-signing-key"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(self.key)], check=True)
        # Only a new disposable VM fixture's repository config; actual user settings never change.
        config = self.repo / ".git/config"
        with config.open("a") as output:
            output.write('\n[user]\n name = Verification Fixture\n email = fixture@example.invalid\n signingkey = ' + json.dumps(str(self.key))
                         + '\n[commit]\n gpgsign = true\n[gpg]\n format = ssh\n[gpg "ssh"]\n program = ssh-keygen\n')
        self.write("module.mjs", "export const answer = 42;\n")
        self.write("unchanged.txt", "OK\n")
        self.write("tests/t_contract.mjs", "import {answer} from '../module.mjs'; Deno.test('unchanged-file contract',()=>{if(answer!==42)throw new Error('regression in unchanged test');});\n")
        self.write("build.mjs", "await Deno.mkdir('client-solid-dist',{recursive:true}); await Deno.writeTextFile('client-solid-dist/index.html','fixture');\n")
        for suite in ["workbench", "variations", "diff", "cache", "feed"]:
            self.write("tests/e2e/" + suite + ".e2e.cjs", "const fs=require('node:fs');if(fs.readFileSync('/work/unchanged.txt','utf8').trim()!=='OK')process.exit(1);console.log('fixture suite passed');\n")
        browser = '#!/usr/bin/env bash\nset -euo pipefail\nfor suite in workbench variations diff cache feed;do\n docker run --rm --network host -v "$PWD":/work -w /work --entrypoint node mcr.microsoft.com/playwright:v1.49.1-noble "/work/tests/e2e/$suite.e2e.cjs"\ndone\n'
        self.write("tests/e2e/run.sh", browser, executable=True)
        run(self.repo, "add", "--", ".")
        run(self.repo, "commit", "-S", "-m", "fixture baseline")
        self.initial = run(self.repo, "rev-parse", "HEAD").stdout.strip()
        self.guest_root = self.root / "guest"
        self.guest_root.mkdir(mode=0o700)
        (self.guest_root / "incoming").mkdir(mode=0o700)
        (self.guest_root / "runs").mkdir(mode=0o700)
        self.config = {"version": 1, "transport": "guest-local", "vm_uuid": self.vm_uuid,
                       "guest_root": str(self.guest_root), "evidence_root": str(self.root / "evidence")}
        self.config_path = self.root / "config.json"
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def write(self, name, data, executable=False):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data)
        path.chmod(0o755 if executable else 0o644)

    def stage(self, *names):
        run(self.repo, "add", "--", *names)

    def activate(self):
        return install.install(self.repo, self.config, tools=TOOLS)

    def commit(self, message):
        return run(self.repo, "commit", "-S", "-m", message, check=False)

    def assert_rejected(self, result, text=None):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(run(self.repo, "rev-parse", "HEAD").stdout.strip(), self.initial)
        if text:
            self.assertIn(text, result.stdout + result.stderr)


class SnapshotTests(VMCase):
    def test_whole_staged_tree_modes_deletion_and_export_ignore(self):
        self.write(".gitattributes", "unchanged.txt export-ignore\n")
        self.write("new script.sh", "#!/bin/sh\nexit 0\n", executable=True)
        self.stage(".gitattributes", "new script.sh")
        self.write("module.mjs", "export const answer = 0;\n")  # deliberately unstaged
        manifest = snapshot.export(self.repo, self.root / "bundle")
        names = {item["path"]: item for item in manifest["files"]}
        self.assertIn("unchanged.txt", names)
        self.assertEqual(names["new script.sh"]["mode"], "100755")
        snapshot.materialize(self.root / "bundle", self.root / "materialized")
        self.assertEqual((self.root / "materialized/module.mjs").read_text(), "export const answer = 42;\n")
        run(self.repo, "rm", "--", "unchanged.txt")
        second = snapshot.export(self.repo, self.root / "deleted-bundle")
        self.assertNotIn("unchanged.txt", {item["path"] for item in second["files"]})

    def test_safe_links_and_rejected_escaping_links(self):
        (self.repo / "inside-link").symlink_to("unchanged.txt")
        self.stage("inside-link")
        snapshot.export(self.repo, self.root / "safe")
        snapshot.materialize(self.root / "safe", self.root / "safe-source")
        (self.repo / "escape").symlink_to("../../outside")
        self.stage("escape")
        snapshot.export(self.repo, self.root / "escape-bundle")
        with self.assertRaises(snapshot.VerificationError):
            snapshot.materialize(self.root / "escape-bundle", self.root / "escape-source")

    def test_byte_and_mode_mutation_are_detected(self):
        manifest = snapshot.export(self.repo, self.root / "bundle")
        snapshot.materialize(self.root / "bundle", self.root / "source")
        path = self.root / "source/module.mjs"
        path.write_text("changed")
        with self.assertRaises(snapshot.VerificationError):
            snapshot.check_inputs(self.root / "source", manifest)
        path.write_text("export const answer = 42;\n")
        (self.root / "source/unchanged.txt").chmod(0o755)
        with self.assertRaisesRegex(snapshot.VerificationError, "executable mode changed"):
            snapshot.check_inputs(self.root / "source", manifest)

    def test_alternate_active_index_is_honored(self):
        alternative = self.root / "active.index"
        env = os.environ | {"GIT_INDEX_FILE": str(alternative)}
        subprocess.run(["git", "-C", str(self.repo), "read-tree", "HEAD"], env=env, check=True)
        self.write("module.mjs", "export const answer = 13;\n")
        subprocess.run(["git", "-C", str(self.repo), "add", "--", "module.mjs"], env=env, check=True)
        with patch.dict(os.environ, {"GIT_INDEX_FILE": str(alternative)}):
            snapshot.export(self.repo, self.root / "alternate")
        snapshot.materialize(self.root / "alternate", self.root / "source")
        self.assertIn("13", (self.root / "source/module.mjs").read_text())


class InstallerTests(VMCase):
    def test_custom_hooks_path_is_not_overridden(self):
        config = self.repo / ".git/config"
        with config.open("a") as output:
            output.write('\n[core]\n hooksPath = "' + str(self.root / "custom-hooks") + '"\n')
        before = config.read_bytes()
        with self.assertRaisesRegex(snapshot.VerificationError, "core.hooksPath"):
            self.activate()
        self.assertEqual(config.read_bytes(), before)

    def test_custom_hook_and_config_remain_untouched(self):
        hook = self.repo / ".git/hooks/pre-commit"
        hook.write_text("#!/bin/sh\nexit 9\n")
        original = hook.read_bytes()
        with self.assertRaises(snapshot.VerificationError):
            self.activate()
        self.assertEqual(hook.read_bytes(), original)

    def test_managed_install_is_idempotent_and_has_no_config_changes(self):
        before = (self.repo / ".git/config").read_bytes()
        hook = self.activate()
        self.activate()
        self.assertIn(install.MARKER, hook.read_text())
        self.assertTrue(hook.stat().st_mode & 0o111)
        self.assertEqual((self.repo / ".git/config").read_bytes(), before)


class ControllerTests(VMCase):
    def fake(self, success=True, mutation=False, missing_phase=False):
        case = self
        class Transport:
            def __init__(self, config):
                self.config = config
            def send(self, bundle, attempt):
                self.bundle, self.attempt = Path(bundle), attempt
                return str(bundle)
            def run(self, remote, log):
                if mutation:
                    case.write("new staged.txt", "index changed")
                    case.stage("new staged.txt")
                return 0 if success else 1
            def collect(self, attempt, evidence):
                Path(evidence).mkdir()
                tree = json.loads((self.bundle / "manifest.json").read_text())["tree"]
                result = {"attempt": attempt, "tree": tree, "success": success,
                          "phases": [{"name": p, "status": 0} for p in (["unit", "build"] if missing_phase else ["unit", "build", "browser"])],
                          "error": "fixture verification failure"}
                (Path(evidence) / "result.json").write_text(json.dumps(result))
        return Transport

    def test_index_mutation_rejects_previous_green_tree(self):
        result = controller.verify(self.config_path, self.repo, transport_factory=self.fake(mutation=True))
        self.assertFalse(result["success"])
        self.assertIn("Staged files changed", result["error"])

    def test_missing_phase_and_failed_transport_reject(self):
        self.assertFalse(controller.verify(self.config_path, self.repo, transport_factory=self.fake(missing_phase=True))["success"])
        self.assertFalse(controller.verify(self.config_path, self.repo, transport_factory=self.fake(success=False))["success"])

    def test_unavailable_vm_is_not_a_local_fallback(self):
        def unavailable(config):
            raise OSError("configured VM unavailable")
        result = controller.verify(self.config_path, self.repo, transport_factory=unavailable)
        self.assertFalse(result["success"])
        self.assertIn("configured VM unavailable", result["error"])

    def test_each_attempt_runs_again_no_green_reuse(self):
        first = controller.verify(self.config_path, self.repo, transport_factory=self.fake())
        second = controller.verify(self.config_path, self.repo, transport_factory=self.fake())
        self.assertTrue(first["success"] and second["success"])
        self.assertNotEqual(first["attempt"], second["attempt"])


class SignedHookTests(VMCase):
    def test_real_passing_commit_is_signed_and_accepted(self):
        self.activate()
        self.write("new.txt", "passing staged addition")
        self.stage("new.txt")
        result = self.commit("passing full fixture")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        public = Path(str(self.key) + ".pub").read_text().strip()
        trusted = self.root / "allowed-signers"
        trusted.write_text("fixture@example.invalid " + public + "\n")
        verified = run(self.repo, "-c", "gpg.ssh.allowedSignersFile=" + str(trusted), "verify-commit", "HEAD")
        self.assertIn("Good", verified.stderr)

    def test_changed_file_regresses_unchanged_test_and_unstaged_fix_does_not_rescue(self):
        self.activate()
        self.write("module.mjs", "export const answer = 13;\n")
        self.stage("module.mjs")
        self.write("module.mjs", "export const answer = 42;\n")
        self.assert_rejected(self.commit("staged regression"), "Full unit checks failed")

    def test_build_failure_blocks_actual_git_commit(self):
        self.activate()
        self.write("build.mjs", "throw new Error('intentional fixture build failure');\n")
        self.stage("build.mjs")
        self.assert_rejected(self.commit("build must block"), "Full build checks failed")

    def test_browser_failure_blocks_actual_git_commit(self):
        self.activate()
        self.write("unchanged.txt", "BAD\n")
        self.stage("unchanged.txt")
        self.assert_rejected(self.commit("browser must block"), "Full browser checks failed")

    def test_busy_vm_blocks_and_retains_staging(self):
        self.activate()
        self.write("new.txt", "still staged")
        self.stage("new.txt")
        with (self.guest_root / "verification.lock").open("a+") as lease:
            fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_rejected(self.commit("busy must block"), "VM is busy")
        self.assertIn("new.txt", run(self.repo, "diff", "--cached", "--name-only").stdout)

    def test_wrong_vm_identity_blocks(self):
        self.config["vm_uuid"] = "00000000-0000-0000-0000-000000000000"
        self.config_path.write_text(json.dumps(self.config))
        self.activate()
        self.write("new.txt", "no host fallback")
        self.stage("new.txt")
        self.assert_rejected(self.commit("wrong guest must block"), "configured virtual machine")

    def test_linked_worktree_invokes_common_hook(self):
        self.activate()
        linked = self.root / "linked"
        run(self.repo, "worktree", "add", "-b", "fixture-linked", str(linked), "HEAD")
        (linked / "module.mjs").write_text("export const answer = 0;\n")
        run(linked, "add", "--", "module.mjs")
        result = run(linked, "commit", "-S", "-m", "linked regression must block", check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Full unit checks failed", result.stdout + result.stderr)
        self.assertEqual(run(linked, "rev-parse", "HEAD").stdout.strip(), self.initial)


if __name__ == "__main__":
    unittest.main()
