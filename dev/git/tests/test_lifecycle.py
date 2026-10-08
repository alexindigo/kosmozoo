import json
import hashlib
from pathlib import Path
import subprocess
from unittest.mock import patch
import uuid

from test_verification import VMCase
import test_verification as fixtures
import controller
import install
import lifecycle
from snapshot import VerificationError


BASE = {"domain": "arch-niri-kosmozoo-precommit-base", "uuid": "93478eba-1eb8-4840-bec4-282cfbbda04c",
        "mac": "52:54:00:31:eb:62", "disk": "/var/lib/libvirt/images/base.qcow2",
        "nvram": "/var/lib/libvirt/qemu/nvram/base.fd"}
OWNED = {"domain": BASE["domain"] + "-run-123", "uuid": "7b27e09e-a9b9-45ce-818a-e69196c335f4",
         "mac": "52:54:00:df:ca:ea", "disk": "/var/lib/libvirt/images/run.qcow2",
         "nvram": "/var/lib/libvirt/qemu/nvram/run.fd"}


def xml(item):
    return f'''<domain><name>{item['domain']}</name><uuid>{item['uuid']}</uuid>
<os><nvram>{item['nvram']}</nvram></os><devices>
<disk type="file" device="disk"><driver type="qcow2"/><source file="{item['disk']}"/></disk>
<interface><mac address="{item['mac']}"/></interface></devices></domain>'''


class OwnershipTests(VMCase):
    def test_destination_running_base_and_checkpoint_changes_block_provisioning(self):
        item = self.invocation()
        item.domain = OWNED["domain"]
        checkpoint = '<domainsnapshot><state>shutoff</state><domain><uuid>' + BASE['uuid'] + '</uuid></domain></domainsnapshot>'
        item.config = {"snapshot": "dev", "snapshot_sha256": hashlib.sha256(checkpoint.encode()).hexdigest()}
        item.config['disk_snapshot'] = {'id': '6', 'name': 'dev', 'date-sec': 123}
        item.host = lambda args: subprocess.CompletedProcess(args, 0, json.dumps({'snapshots': [item.config['disk_snapshot']]}), '')
        def response(*args, **kwargs):
            value = {"dumpxml": xml(BASE), "domstate": "shut off\n", "snapshot-dumpxml": checkpoint, "dominfo": ""}[args[0]]
            return subprocess.CompletedProcess(args, 1 if args[0] == "dominfo" else 0, value, "")
        item.virsh = response
        item.inventory = lambda: [xml(BASE)]
        item.base_guard()
        item.inventory = lambda: [xml(BASE), xml(OWNED)]
        with self.assertRaisesRegex(VerificationError, "collision"):
            item.base_guard()
        item.inventory = lambda: [xml(BASE)]
        item.config['snapshot_sha256'] = '0' * 64
        with self.assertRaisesRegex(VerificationError, "checkpoint changed"):
            item.base_guard()
        item.config['snapshot_sha256'] = hashlib.sha256(checkpoint.encode()).hexdigest()
        def running(*args, **kwargs):
            return subprocess.CompletedProcess(args, 0, "running\n", "") if args[0] == "domstate" else response(*args, **kwargs)
        item.virsh = running
        with self.assertRaisesRegex(VerificationError, "stay shut off"):
            item.base_guard()

    def test_physical_snapshot_selection_rejects_absence_duplicates_and_changed_record(self):
        item = self.invocation()
        item.domain = OWNED['domain']
        checkpoint = '<domainsnapshot><state>shutoff</state><domain><uuid>' + BASE['uuid'] + '</uuid></domain></domainsnapshot>'
        selected = {'id': '7', 'name': 'precommit-ready', 'date-sec': 456}
        item.config = {'snapshot': 'precommit-ready', 'snapshot_sha256': hashlib.sha256(checkpoint.encode()).hexdigest(),
                       'disk_snapshot': selected}
        def response(*args, **kwargs):
            value = {'dumpxml': xml(BASE), 'domstate': 'shut off\n', 'snapshot-dumpxml': checkpoint, 'dominfo': ''}[args[0]]
            return subprocess.CompletedProcess(args, 1 if args[0] == 'dominfo' else 0, value, '')
        item.virsh = response
        item.inventory = lambda: [xml(BASE)]
        for snapshots in [[], [selected, selected | {'id': '8'}], [selected | {'date-sec': 999}]]:
            with self.subTest(snapshots=snapshots):
                item.host = lambda args: subprocess.CompletedProcess(args, 0, json.dumps({'snapshots': snapshots}), '')
                with self.assertRaises(VerificationError):
                    item.base_guard()
        item.host = lambda args: subprocess.CompletedProcess(args, 0, json.dumps({'snapshots': [selected]}), '')
        item.base_guard()

    def test_base_or_shared_storage_cannot_be_retired(self):
        with self.assertRaises(VerificationError):
            lifecycle.assert_private(BASE, BASE, [])
        for key in ["disk", "nvram"]:
            with self.assertRaises(VerificationError):
                lifecycle.assert_private(OWNED | {key: BASE[key]}, BASE, [])
            other = BASE | {key: OWNED[key]}
            with self.assertRaisesRegex(VerificationError, "another domain"):
                lifecycle.assert_private(OWNED, BASE, [xml(other)])
        lifecycle.assert_private(OWNED, BASE, [xml(BASE), xml(OWNED)])

    def test_unsupported_layout_and_changed_identity_reject(self):
        self.assertEqual(lifecycle.identity(xml(OWNED)), OWNED)
        for extra in ['<filesystem/>', '<disk type="file" device="disk"/>']:
            with self.assertRaises(VerificationError):
                lifecycle.identity(xml(OWNED).replace('</devices>', extra + '</devices>'))

    def invocation(self):
        item = object.__new__(lifecycle.Invocation)
        item.base = BASE
        item.record = {"owned": OWNED, "status": "ready"}
        item.persist = lambda: None
        item.inventory = lambda: [xml(BASE), xml(OWNED)]
        item.wait = lambda query, *args, **kwargs: query()
        return item

    def test_teardown_fences_identity_and_only_removes_after_shutdown(self):
        item = self.invocation()
        calls = []
        def virsh(*args, **kwargs):
            calls.append(args)
            if args[0] == "dumpxml":
                return subprocess.CompletedProcess(args, 0, xml(OWNED), "")
            if args[0] == "dominfo":
                return subprocess.CompletedProcess(args, 1, "", "not found")
            return subprocess.CompletedProcess(args, 0, "shut off\n", "")
        item.virsh = virsh
        item.host = lambda args: calls.append(tuple(args))
        item.retire()
        self.assertEqual(item.record["status"], "removed")
        operations = [c[0] for c in calls]
        self.assertLess(operations.index("shutdown"), operations.index("undefine"))
        self.assertEqual(next(c for c in calls if c[0] == "undefine")[1], OWNED["uuid"])
        item = self.invocation()
        item.virsh = lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, xml(BASE), "")
        with self.assertRaisesRegex(VerificationError, "changed before cleanup"):
            item.retire()


class FreshControllerTests(VMCase):
    fake = fixtures.ControllerTests.fake

    def run_fresh(self, failure=None, **options):
        self.config["transport"] = "fresh-vm"
        self.config["base"] = BASE
        self.config_path.write_text(json.dumps(self.config))
        case, records = self, []
        transport = self.fake(**options)
        class Invocation:
            def __init__(self, config, module, run):
                self.id = str(uuid.uuid4())
                records.append(("created", self.id))
            def prepare(self):
                if failure == "setup":
                    raise OSError("base unavailable")
                if failure == "interruption":
                    raise KeyboardInterrupt("interrupted")
                return case.config
            def retire(self):
                if failure == "cleanup":
                    raise OSError("cleanup failed")
                records.append(("removed", self.id))
            def retain(self, error):
                records.append(("retained", self.id))
        with patch.object(controller, "Invocation", Invocation), \
             patch.object(controller, "transfer_module", return_value=None), \
             patch.object(controller, "RemoteVM", transport):
            result = controller.verify(self.config_path, self.repo)
        return result, records

    def test_each_success_creates_then_retires_a_distinct_invocation(self):
        first, a = self.run_fresh()
        second, b = self.run_fresh()
        self.assertTrue(first["success"] and second["success"])
        self.assertEqual([p for p, _ in a], ["created", "removed"])
        self.assertNotEqual(a[0][1], b[0][1])

    def test_failed_setup_result_index_and_cleanup_retain_invocation(self):
        for options in [{"failure": "setup"}, {"success": False}, {"mutation": True},
                        {"missing_phase": True}, {"failure": "cleanup"}, {"failure": "interruption"}]:
            result, records = self.run_fresh(**options)
            self.assertFalse(result["success"])
            self.assertEqual([p for p, _ in records], ["created", "retained"])

    def test_missing_manifest_cannot_trigger_success_cleanup(self):
        factory = self.fake()
        original = factory.collect
        def collect(item, attempt, evidence):
            original(item, attempt, evidence)
            (Path(evidence) / "manifest.json").unlink()
        with patch.object(factory, "collect", collect):
            result = controller.verify(self.config_path, self.repo, transport_factory=factory)
        self.assertFalse(result["success"])

    def test_config_migration_requires_exact_expected_configuration(self):
        self.activate()
        new = self.config | {"transport": "fresh-vm", "base": BASE}
        with self.assertRaises(VerificationError):
            install.install(self.repo, new, expected_config={"wrong": "config"})
        install.install(self.repo, new, expected_config=self.config)
        backups = list((self.repo / ".git/kosmozoo-verification").glob("config-before-*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(json.loads(backups[0].read_text()), self.config)
