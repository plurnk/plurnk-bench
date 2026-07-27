import asyncio
import importlib
import shlex
import sqlite3
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from pathlib import PurePosixPath


def install_pier_stubs() -> None:
    module_names = [
        "pier",
        "pier.agents",
        "pier.agents.installed",
        "pier.agents.installed.base",
        "pier.environments",
        "pier.environments.base",
        "pier.models",
        "pier.models.agent",
        "pier.models.agent.context",
        "pier.models.agent.install",
        "pier.models.agent.network",
        "pier.models.trial",
        "pier.models.trial.paths",
    ]
    for name in module_names:
        sys.modules[name] = types.ModuleType(name)

    class BaseInstalledAgent:
        def __init__(self, *args, **kwargs):
            self._version = "test"
            self._extra_env = {}

        def build_process_env(self, env):
            return env

        async def exec_as_agent(self, environment, command, env):
            environment.command = command
            environment.env = env

        def _get_env(self, name):
            return self._extra_env.get(name)

    class AgentInstallSpec:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class InstallStep:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class NetworkAllowlist:
        def __init__(self, domains):
            self.domains = domains

    sys.modules["pier.agents.installed.base"].BaseInstalledAgent = BaseInstalledAgent
    sys.modules["pier.agents.installed.base"].with_prompt_template = lambda fn: fn
    sys.modules["pier.environments.base"].BaseEnvironment = object
    sys.modules["pier.models.agent.context"].AgentContext = object
    sys.modules["pier.models.agent.install"].AgentInstallSpec = AgentInstallSpec
    sys.modules["pier.models.agent.install"].InstallStep = InstallStep
    sys.modules["pier.models.agent.network"].NetworkAllowlist = NetworkAllowlist
    sys.modules["pier.models.trial.paths"].EnvironmentPaths = types.SimpleNamespace(
        agent_dir=PurePosixPath("/logs/agent"),
    )


install_pier_stubs()
driver = importlib.import_module("driver")


class DriverContractTest(unittest.TestCase):
    def test_install_uses_exact_requested_versions(self):
        agent = driver.PlurnkAgent(client_version="0.71.3", service_version="1.3.2")
        spec = agent.install_spec()
        command = spec.steps[0].run

        self.assertIn("@plurnk/plurnk-service@1.3.2", command)
        self.assertIn("@plurnk/plurnk@0.71.3", command)
        self.assertNotIn("@latest", command)
        self.assertEqual(
            spec.metadata,
            {
                "client": {"source": "npm", "version": "0.71.3"},
                "service": {"source": "npm", "version": "1.3.2"},
            },
        )

    def test_install_uses_exact_source_candidate(self):
        commit = "a" * 40
        sha256 = "b" * 64
        agent = driver.PlurnkAgent(
            client_version="0.71.4",
            service_source_url="http://192.0.2.1:1234/plurnk-service.tar",
            service_source_commit=commit,
            service_source_sha256=sha256,
        )
        spec = agent.install_spec()
        command = spec.steps[0].run

        self.assertIn("sha256sum -c -", command)
        self.assertIn("npm ci", command)
        self.assertIn("npm run build", command)
        self.assertIn("npm link --workspace @plurnk/plurnk-service", command)
        self.assertNotIn("@plurnk/plurnk-service@latest", command)
        self.assertEqual(
            spec.metadata["service"],
            {"source": "git", "commit": commit, "sha256": sha256},
        )
        self.assertEqual(
            spec.cache_key,
            f"plurnk-source-{sha256[:16]}-client-0.71.4-node-{driver.NODE_MAJOR}",
        )

    def test_install_rejects_ambiguous_source_candidate(self):
        with self.assertRaisesRegex(ValueError, "requires URL, commit, and SHA-256"):
            driver.PlurnkAgent(
                client_version="0.71.4",
                service_source_url="http://192.0.2.1/plurnk-service.tar",
            ).install_spec()
        with self.assertRaisesRegex(ValueError, "mutually exclusive"):
            driver.PlurnkAgent(
                client_version="0.71.4",
                service_version="1.3.2",
                service_source_url="http://192.0.2.1/plurnk-service.tar",
                service_source_commit="a" * 40,
                service_source_sha256="b" * 64,
            ).install_spec()
        with self.assertRaisesRegex(ValueError, "client_version"):
            driver.PlurnkAgent(service_version="1.3.2").install_spec()

    def test_snapshot_is_wal_safe_and_has_no_copy_fallback(self):
        agent = driver.PlurnkAgent()
        environment = types.SimpleNamespace()

        asyncio.run(agent.run("task", environment, object()))

        self.assertIn("plurnk --json --auto ", environment.command)
        self.assertNotIn(" --yolo ", environment.command)
        self.assertIn("VACUUM INTO", environment.command)
        self.assertIn('snapshot_db "$DB" /logs/agent/plurnk.db', environment.command)
        self.assertNotRegex(environment.command, r"(?m)^cp ")

    def test_snapshot_includes_committed_wal_state(self):
        agent = driver.PlurnkAgent()
        environment = types.SimpleNamespace()
        asyncio.run(agent.run("task", environment, object()))
        snapshot_function = environment.command.split("plurnk-service start", 1)[0]

        with tempfile.TemporaryDirectory() as directory:
            source_path = Path(directory, "source.db")
            destination_path = Path(directory, "snapshot.db")
            source = sqlite3.connect(source_path)
            try:
                source.execute("PRAGMA journal_mode=WAL")
                source.execute("PRAGMA wal_autocheckpoint=0")
                source.execute("CREATE TABLE specimen(value TEXT)")
                source.execute("INSERT INTO specimen VALUES ('from-wal')")
                source.commit()
                self.assertTrue(Path(f"{source_path}-wal").exists())

                command = (
                    snapshot_function
                    + f"\nsnapshot_db {shlex.quote(str(source_path))} "
                    + shlex.quote(str(destination_path))
                )
                subprocess.run(["bash", "-c", command], check=True)
            finally:
                source.close()

            snapshot = sqlite3.connect(destination_path)
            try:
                row = snapshot.execute("SELECT value FROM specimen").fetchone()
            finally:
                snapshot.close()

            self.assertEqual(row, ("from-wal",))


if __name__ == "__main__":
    unittest.main()
