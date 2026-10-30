import tempfile
import unittest
import logging
import hashlib
import json
from pathlib import Path

from swebench.container import EnvironmentFormatter, candidate_argv, configuration, provisioning_command, resolver_configuration
from swebench.oracle import inject_eval_fixes, install_harness_fixes


class ContainerContract(unittest.TestCase):
    def test_resolver_override_is_opt_in_and_cannot_change_trial_networks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(resolver_configuration(root, ""), ([], None))
            source = root / "operator-resolv.conf"
            content = b"nameserver 192.0.2.53\noptions timeout:2\n"
            source.write_bytes(content)
            files, provenance = resolver_configuration(root, str(source))
            self.assertEqual(provenance, {"source": str(source), "sha256": hashlib.sha256(content).hexdigest()})
            self.assertEqual(len(files), 1)
            overlay = json.loads(files[0].read_text())
            self.assertEqual(set(overlay), {"services"})
            self.assertEqual(set(overlay["services"]), {"main", "harbor-docker-egress-control-sidecar"})
            for service in overlay["services"].values():
                self.assertEqual(set(service), {"volumes"})
                mount, = service["volumes"]
                self.assertEqual(mount, {"type": "bind", "source": str(root / "resolv.conf"),
                                         "target": "/etc/resolv.conf", "read_only": True})
                self.assertEqual(Path(mount["source"]).read_bytes(), content)
            source.write_text("nameserver 198.51.100.53\n")
            self.assertEqual((root / "resolv.conf").read_bytes(), content, "the trial retains its initial configuration")

    def test_invalid_resolver_file_fails_before_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "resolver configuration must be a file"):
                resolver_configuration(root, directory)
            with self.assertRaises(FileNotFoundError):
                resolver_configuration(root, str(root / "missing"))

    def test_backend_failures_are_visible_without_environment_secrets(self):
        record = logging.LogRecord("backend", logging.WARNING, "backend.py", 42,
                                   "Teardown failed after exec TOKEN=%s: network unavailable", ("fixture-private-token",), None)
        message = EnvironmentFormatter({"TOKEN": "fixture-private-token"}).format(record)
        self.assertIn("Teardown failed", message)
        self.assertIn("network unavailable", message)
        self.assertNotIn("fixture-private-token", message)

    def test_mounts_are_explicit_and_runtime_is_read_only(self):
        with tempfile.TemporaryDirectory() as root:
            request = {"allowedHosts": ["api.example.com"]}
            for name in ("runtime", "repository", "agent"):
                path = Path(root) / name
                path.mkdir()
                request[name] = str(path)
            with self.assertRaisesRegex(ValueError, "runtime bundle has no bin/node"):
                configuration(request)
            node = Path(request["runtime"]) / "bin" / "node"
            node.parent.mkdir()
            node.write_text("node fixture\n")
            mounts, policy = configuration(request)
            self.assertEqual([m["target"] for m in mounts], ["/opt/plurnk", "/testbed", "/var/lib/plurnk", "/usr/local/bin/node"])
            self.assertEqual([m["read_only"] for m in mounts], [True, False, False, True])
            self.assertEqual(mounts[-1]["source"], str(node))
            self.assertEqual(policy, {"network_mode": "allowlist", "allowed_hosts": ["api.example.com"]})
            request["allowedHosts"] = []
            with self.assertRaisesRegex(ValueError, "explicit model-host"):
                configuration(request)
            request["loopbackPorts"] = [11435]
            self.assertEqual(configuration(request)[1], {"network_mode": "no-network", "allowed_hosts": []})
            for bad in ([0], [70000], ["11435"], [True], "11435"):
                request["loopbackPorts"] = bad
                with self.assertRaisesRegex(ValueError, "loopbackPorts"):
                    configuration(request)
            del request["loopbackPorts"]
            request["preflight"] = True
            self.assertEqual(configuration(request)[1]["network_mode"], "no-network")
            self.assertIn("chown -R plurnk:plurnk /testbed", provisioning_command({"argv": ["plurnk"]}))
            self.assertIn("chown -R $(id -u):$(id -g) /testbed", provisioning_command({"argv": ["pi"]}))
            self.assertEqual(
                candidate_argv({"argv": ["plurnk", "-p", "task"]}),
                ["/opt/plurnk/bin/node", "/opt/plurnk/runner.mjs", "plurnk", "-p", "task"],
            )
            self.assertEqual(
                candidate_argv({"argv": ["pi"], "loopbackPorts": [11435]}),
                ["/opt/plurnk/bin/node", "--import=/var/lib/plurnk/loopback.mjs", "/opt/plurnk/runner.mjs", "pi"],
            )

    def test_oracle_fixes_guard_container_listing_airgap_and_local_httpbin(self):
        class FakeContainerCollection:
            def list(self, *args, **kwargs):
                return args, kwargs

            def create(self, *args, **kwargs):
                return args, kwargs

        class FakeRunEvaluation:
            START_TEST_OUTPUT = ">>>>> Start Test Output"

            @staticmethod
            def _inject_asset_restore(eval_script, restore_cmds):
                return eval_script

        install_harness_fixes(FakeRunEvaluation, FakeContainerCollection)
        install_harness_fixes(FakeRunEvaluation, FakeContainerCollection)
        collection = FakeContainerCollection()
        self.assertEqual(collection.list(all=True), ((), {"all": True, "ignore_removed": True}))
        self.assertEqual(
            collection.list(all=True, ignore_removed=False),
            ((), {"all": True, "ignore_removed": False}),
        )
        self.assertEqual(collection.create(image="x"), ((), {"image": "x", "network_disabled": True}))
        self.assertEqual(
            collection.create(image="x", network_mode="none"),
            ((), {"image": "x", "network_mode": "none"}),
        )

        script = "#!/bin/bash\n: '>>>>> Start Test Output'\npytest -rA\n: '>>>>> End Test Output'\ngit checkout test_requests.py\n"
        injected = FakeRunEvaluation._inject_asset_restore(script, ["cp /image_assets/a a"])
        self.assertTrue(injected.endswith("\n"))
        start_idx = injected.index(": '>>>>> Start Test Output'")
        asset_idx = injected.index("cp /image_assets/a a")
        refresh_idx = injected.index("cp /tmp/swebench_httpbin.crt requests/cacert.pem")
        restore_idx = injected.index("git checkout -- requests/cacert.pem")
        self.assertLess(asset_idx, refresh_idx)
        self.assertLess(refresh_idx, start_idx)
        self.assertGreater(restore_idx, injected.index("git checkout test_requests.py"))


if __name__ == "__main__":
    unittest.main()
