import tempfile
import unittest
import logging
from pathlib import Path

from swebench.container import EnvironmentFormatter, configuration


class ContainerContract(unittest.TestCase):
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
            mounts, policy = configuration(request)
            self.assertEqual([m["target"] for m in mounts], ["/opt/harness", "/testbed", "/logs/agent"])
            self.assertEqual([m["read_only"] for m in mounts], [True, False, False])
            self.assertEqual(policy, {"network_mode": "allowlist", "allowed_hosts": ["api.example.com"]})
            request["allowedHosts"] = []
            with self.assertRaisesRegex(ValueError, "explicit model-host"):
                configuration(request)
            request["preflight"] = True
            self.assertEqual(configuration(request)[1]["network_mode"], "no-network")


if __name__ == "__main__":
    unittest.main()
