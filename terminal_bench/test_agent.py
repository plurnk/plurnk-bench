import asyncio
import importlib
import json
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path, PurePosixPath
from unittest.mock import patch


def install_harbor_stubs() -> None:
    for name in [
        "harbor", "harbor.agents", "harbor.agents.installed", "harbor.agents.installed.base",
        "harbor.environments", "harbor.environments.base", "harbor.models", "harbor.models.agent",
        "harbor.models.agent.context", "harbor.models.trial", "harbor.models.trial.paths",
    ]:
        sys.modules[name] = types.ModuleType(name)

    class BaseInstalledAgent:
        def __init__(self, *args, **kwargs):
            self._extra_env = kwargs.get("extra_env") or {}
            self.model_name = kwargs.get("model_name")

        def _get_env(self, name):
            return self._extra_env.get(name)

        async def exec_as_agent(self, environment, command, env):
            environment.command = command
            environment.env = env

        async def exec_as_root(self, environment, command, env):
            environment.command = command
            environment.env = env

    sys.modules["harbor.agents.installed.base"].BaseInstalledAgent = BaseInstalledAgent
    sys.modules["harbor.agents.installed.base"].with_prompt_template = lambda fn: fn
    sys.modules["harbor.environments.base"].BaseEnvironment = object
    sys.modules["harbor.models.agent.context"].AgentContext = object
    sys.modules["harbor.models.trial.paths"].EnvironmentPaths = types.SimpleNamespace(
        agent_dir=PurePosixPath("/logs/agent"),
    )


install_harbor_stubs()
sys.path.insert(0, str(PurePosixPath(__file__).parent))
agent_module = importlib.import_module("plurnk_agent")

ROUTE = "fireworks-ai/accounts/fireworks/models/kimi-k3"


def agent(**extra_env):
    return agent_module.PlurnkAgent(extra_env=extra_env)


class PlainTaskTreeTest(unittest.TestCase):
    """[§frontier-parity] a task directory outside any repository is admitted as service members."""

    def test_run_admits_the_tree_only_outside_a_repository(self):
        environment = types.SimpleNamespace()
        asyncio.run(agent(PLURNK_MODEL="test", PLURNK_MODEL_test=ROUTE).run("task", environment, object()))
        command = environment.command
        guard = command.index('if ! git -C "$PWD" rev-parse --show-toplevel')
        self.assertIn('PLURNK_MEMBERS_TASK="${PWD#/}/**"', command)
        self.assertIn('--project-root "$project_root" --timeout', command)
        self.assertLess(guard, command.index("plurnk-service start"), "membership is decided before the daemon boots")
        self.assertNotIn("git init", command, "the harness never turns a task tree into a repository")
        self.assertEqual(environment.env["PLURNK_MODEL"], "test")
        self.assertEqual(environment.env["PLURNK_SERVICE_DB_PATH"], "/logs/agent/plurnk.db")


class InstallationEvidenceTest(unittest.TestCase):
    """{§frontier-setup-evidence}: retained output exists before setup finishes."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="plurnk-install-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.logs = self.root / "logs"
        self.apt = self.root / "apt"
        (self.apt / "sources.list.d").mkdir(parents=True)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        fixture = (Path(__file__).parent / "fixtures" / "install-command.mjs").resolve()
        for name in ["apt-get", "curl", "npm", "git", "plurnk", "plurnk-service"]:
            (self.bin / name).symlink_to(fixture)
        environment = types.SimpleNamespace()
        with patch.object(agent_module.EnvironmentPaths, "agent_dir", self.logs), \
             patch.object(agent_module, "APT_DIR", self.apt):
            asyncio.run(agent().install(environment))
        self.command = environment.command
        self.env = {**os.environ, **environment.env, "PATH": f"{self.bin}:{os.environ['PATH']}"}

    def start(self, **env):
        process = subprocess.Popen(["bash", "-c", self.command], cwd=self.root,
                                   env={**self.env, **env}, start_new_session=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def cleanup():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=10)

        self.addCleanup(cleanup)
        return process

    def test_success_retains_both_streams_and_completion(self):
        process = self.start()
        stdout, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr)
        log = (self.logs / "setup" / "install.log").read_text()
        self.assertIn("apt-get update stdout", log)
        self.assertIn("apt-get update stderr", log)
        self.assertIn("plurnk setup: exit 0", log)
        self.assertEqual(stdout, log)

    def test_official_archives_use_https_without_changing_suites_or_third_party_sources(self):
        sources = {
            self.apt / "sources.list": "deb http://archive.ubuntu.com/ubuntu noble main\n",
            self.apt / "sources.list.d" / "ubuntu.sources": "Types: deb\nURIs: http://security.ubuntu.com/ubuntu\nSuites: noble-security\n",
            self.apt / "sources.list.d" / "debian.sources": "URIs: http://deb.debian.org/debian http://security.debian.org/debian-security\nSuites: bookworm bookworm-security\n",
            self.apt / "sources.list.d" / "custom.list": "deb http://example.org/repo stable main\n",
        }
        for path, content in sources.items():
            path.write_text(content)
        process = self.start()
        process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0)
        for path, content in sources.items():
            expected = content if path.name == "custom.list" else content.replace("http://", "https://")
            self.assertEqual(path.read_text(), expected)

    def test_failure_retains_exit_status_and_does_not_run_later_steps(self):
        process = self.start(TEST_SETUP_FAIL="1")
        process.communicate(timeout=10)
        self.assertEqual(process.returncode, 7)
        log = (self.logs / "setup" / "install.log").read_text()
        self.assertIn("apt-get update stderr", log)
        self.assertIn("plurnk setup: exit 7", log)
        self.assertNotIn("npm install", log)

    def test_cancellation_retains_live_output_without_a_completion_claim(self):
        process = self.start(TEST_SETUP_HANG="1")
        log_path = self.logs / "setup" / "install.log"
        deadline = time.monotonic() + 5
        while not log_path.exists() or "apt-get update stderr" not in log_path.read_text():
            self.assertIsNone(process.poll())
            self.assertLess(time.monotonic(), deadline, "setup output did not become durable while running")
            time.sleep(0.01)
        os.killpg(process.pid, signal.SIGTERM)
        process.communicate(timeout=10)
        self.assertNotEqual(process.returncode, 0)
        log = log_path.read_text()
        self.assertIn("apt-get update stdout", log)
        self.assertIn("apt-get update stderr", log)
        self.assertNotIn("plurnk setup: exit 0", log)


class ExecutionTest(unittest.TestCase):
    """{§frontier-evidence}: execute the driver's real shell, including abrupt process-group death."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="plurnk-harbor-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.task = self.root / "app"
        self.task.mkdir()
        self.logs = self.root / "logs"
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        for name, source in [("plurnk", "client.mjs"), ("plurnk-service", "daemon.mjs")]:
            executable = bin_dir / name
            executable.write_bytes((Path(__file__).parent / "fixtures" / source).read_bytes())
            executable.chmod(0o755)
        environment = types.SimpleNamespace()
        with patch.object(agent_module.EnvironmentPaths, "agent_dir", self.logs):
            asyncio.run(agent(PLURNK_MODEL="test", PLURNK_MODEL_test=ROUTE).run("unaltered task", environment, object()))
        self.command = environment.command
        self.env = {**os.environ, **environment.env, "PATH": f"{bin_dir}:{os.environ['PATH']}"}
        self.env.pop("PLURNK_MEMBERS_TASK", None)
        self.env.pop("PLURNK_MEMBERS_ENABLED", None)

    def start(self, **env):
        process = subprocess.Popen(["bash", "-c", self.command], cwd=self.task,
                                   env={**self.env, **env}, start_new_session=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

        def cleanup():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=10)

        self.addCleanup(cleanup)
        return process

    def read_evidence(self):
        with sqlite3.connect(self.logs / "plurnk.db") as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone(), ("ok",))
            self.assertEqual(db.execute("SELECT body FROM evidence").fetchall(), [("committed before termination",)])

    def test_plain_tree_uses_container_root_and_scoped_membership(self):
        process = self.start(TEST_CLIENT_EXIT="0")
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr)
        record = json.loads((self.logs / "plurnk.json").read_text())
        self.assertEqual(record["args"][record["args"].index("--project-root") + 1], "/")
        self.assertEqual(record["members"], f"{str(self.task).lstrip('/')}/**")
        self.assertEqual(record["enabled"], '["task"]')
        self.assertEqual(record["args"][-1], "unaltered task")
        self.read_evidence()

    def test_repository_preserves_git_membership_and_records_client_failure(self):
        subprocess.run(["git", "init", "-q", str(self.task)], check=True)
        process = self.start(TEST_CLIENT_EXIT="9")
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 0, stderr)
        record = json.loads((self.logs / "plurnk.json").read_text())
        self.assertEqual(record["args"][record["args"].index("--project-root") + 1], str(self.task))
        self.assertIsNone(record["members"])
        self.assertEqual((self.logs / "client-exit-code.txt").read_text().strip(), "9")
        self.read_evidence()

    def assert_signal_retains_database(self, sig):
        process = self.start()
        record = self.logs / "plurnk.json"
        deadline = time.monotonic() + 10
        while not record.exists() or record.stat().st_size == 0:
            self.assertIsNone(process.poll(), "the driver exited before its client ran")
            self.assertLess(time.monotonic(), deadline, "client readiness deadline")
            time.sleep(0.01)
        os.killpg(process.pid, sig)
        process.communicate(timeout=10)
        self.assertIn(process.returncode, [-sig, 128 + sig])
        self.read_evidence()

    def test_sigterm_retains_database(self):
        self.assert_signal_retains_database(signal.SIGTERM)

    def test_sigkill_retains_database_and_wal(self):
        self.assert_signal_retains_database(signal.SIGKILL)

    def test_daemon_failure_is_not_a_successful_trial(self):
        process = self.start(TEST_BOOT_FAIL="1")
        _, stderr = process.communicate(timeout=10)
        self.assertEqual(process.returncode, 7)
        self.assertIn("daemon did not become ready", stderr)
        self.assertFalse((self.logs / "plurnk.json").exists())


if __name__ == "__main__":
    unittest.main()
