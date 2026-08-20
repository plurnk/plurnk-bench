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
        command = agent.install_spec().steps[0].run

        self.assertIn("@plurnk/plurnk-service@1.3.2", command)
        self.assertIn("@plurnk/plurnk@0.71.3", command)
        self.assertNotIn("@latest", command)

    def test_snapshot_is_wal_safe_and_has_no_copy_fallback(self):
        agent = driver.PlurnkAgent()
        environment = types.SimpleNamespace()

        asyncio.run(agent.run("task", environment, object()))

        self.assertIn("plurnk --json --auto ", environment.command)
        self.assertNotIn(" --yolo ", environment.command)
        self.assertIn("backup(source, process.argv[2])", environment.command)
        self.assertIn('${XDG_DATA_HOME:-$HOME/.local/share}/plurnk/plurnk.db', environment.command)
        self.assertNotIn("VACUUM INTO", environment.command)
        self.assertIn('snapshot_db "$DB" /logs/agent/plurnk.db', environment.command)
        self.assertNotRegex(environment.command, r"(?m)^cp ")

    def test_web_materialization_provenance_contains_no_credential(self):
        agent = driver.PlurnkAgent(tavily_configured="1", tavily_depth="advanced")
        environment = types.SimpleNamespace()

        asyncio.run(agent.run("task", environment, object()))

        self.assertIn("/logs/agent/plurnk-bench.json", environment.command)
        self.assertIn('"configured": true', environment.command)
        self.assertIn('"depth": "advanced"', environment.command)
        self.assertNotIn("TAVILY_API_KEY", environment.command)

    def test_snapshot_includes_committed_wal_state(self):
        # Keep the fixture and oracle independent of the Node backup path under test.
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
