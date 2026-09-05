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


class EmbeddingRouteTest(unittest.TestCase):
    """[§frontier-parity] the container embeds over ONE route, as the corpus driver carries it."""

    def test_default_is_the_bundled_model_as_an_explicit_empty_selection(self):
        self.assertEqual(agent()._embedding_env(), {"PLURNK_EMBEDDING_MODEL": ""})
        self.assertEqual(agent(PLURNK_BENCH_EMBEDDING_ROUTE="bundled")._embedding_env(), {"PLURNK_EMBEDDING_MODEL": ""})

    def test_hosted_route_rides_with_its_openai_compatible_provider_lines(self):
        env = agent(
            PLURNK_BENCH_EMBEDDING_ROUTE="local-embed/sentence-transformers/all-MiniLM-L6-v2",
            PLURNK_BENCH_EMBEDDING_BASE_URL="https://embed.plurnk.ai/v1",
            PLURNK_EMBEDDING_MODEL="operator/own-model",
        )._embedding_env()
        self.assertEqual(env, {
            "PLURNK_EMBEDDING_MODEL": "local-embed/sentence-transformers/all-MiniLM-L6-v2",
            "PLURNK_PROVIDERS_PROVIDER_LOCAL_EMBED_NPM": "@ai-sdk/openai-compatible",
            "PLURNK_PROVIDERS_PROVIDER_LOCAL_EMBED_BASE_URL": "https://embed.plurnk.ai/v1",
        })

    def test_hosted_route_without_a_base_url_fails_before_launch(self):
        with self.assertRaisesRegex(ValueError, "PLURNK_BENCH_EMBEDDING_BASE_URL"):
            agent(PLURNK_BENCH_EMBEDDING_ROUTE="local-embed/x")._embedding_env()


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
        self.assertEqual(environment.env["PLURNK_EMBEDDING_MODEL"], "")
        self.assertEqual(environment.env["PLURNK_SERVICE_DB_PATH"], "/logs/agent/plurnk.db")


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
