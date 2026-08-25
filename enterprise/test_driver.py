import asyncio
import importlib
import json
import sys
import types
import unittest
from pathlib import PurePosixPath


def install_harbor_stubs() -> None:
    module_names = [
        "harbor",
        "harbor.agents",
        "harbor.agents.installed",
        "harbor.agents.installed.base",
        "harbor.environments",
        "harbor.environments.base",
        "harbor.models",
        "harbor.models.agent",
        "harbor.models.agent.context",
        "harbor.models.trial",
        "harbor.models.trial.paths",
    ]
    for name in module_names:
        sys.modules[name] = types.ModuleType(name)

    class BaseInstalledAgent:
        def __init__(self, *args, mcp_servers=None, extra_env=None, **kwargs):
            self._version = "test"
            self._extra_env = dict(extra_env or {})
            self.mcp_servers = list(mcp_servers or [])

        async def exec_as_root(self, environment, command, env=None):
            environment.root_command = command
            environment.root_env = env

        async def exec_as_agent(self, environment, command, env=None):
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
driver = importlib.import_module("driver")


def server(name: str, url: str, transport: str = "streamable-http") -> types.SimpleNamespace:
    return types.SimpleNamespace(name=name, transport=transport, url=url)


BENCH_SERVERS = [
    server("pm", "http://host.docker.internal:8011/mcp"),
    server("crm", "http://host.docker.internal:8012/mcp"),
    server("file-server", "http://host.docker.internal:8013/mcp"),
]


class DriverContractTest(unittest.TestCase):
    def test_install_uses_exact_requested_versions(self):
        agent = driver.PlurnkAgent(client_version="0.76.2", service_version="1.9.2")
        environment = types.SimpleNamespace()

        asyncio.run(agent.install(environment))

        self.assertIn("@plurnk/plurnk-service@1.9.2", environment.root_command)
        self.assertIn("@plurnk/plurnk@0.76.2", environment.root_command)
        self.assertNotIn("@latest", environment.root_command)
        self.assertIn("setup_26.x", environment.root_command)

    def test_mcp_carriage_declares_each_bench_service_as_a_plurnk_http_server(self):
        agent = driver.PlurnkAgent(mcp_servers=BENCH_SERVERS, mcp_host="192.168.1.20")

        env = agent.mcp_environment()

        self.assertEqual(env["PLURNK_MCP_PM"], "http://192.168.1.20:8011/mcp")
        self.assertEqual(env["PLURNK_MCP_CRM"], "http://192.168.1.20:8012/mcp")
        self.assertEqual(env["PLURNK_MCP_FILESERVER"], "http://192.168.1.20:8013/mcp")
        self.assertEqual(json.loads(env["PLURNK_MCP_ENABLED"]), ["pm", "crm", "fileserver"])
        self.assertEqual(json.loads(env["PLURNK_MCP_EXPANDED"]), ["pm", "crm", "fileserver"])
        self.assertEqual(env["PLURNK_EXECS_ONLY"], "sh,pm,crm,fileserver")

    def test_mcp_host_is_only_rewritten_when_given(self):
        agent = driver.PlurnkAgent(mcp_servers=BENCH_SERVERS)

        env = agent.mcp_environment()

        self.assertEqual(env["PLURNK_MCP_PM"], "http://host.docker.internal:8011/mcp")

    def test_mcp_carriage_fails_hard_without_servers_or_with_stdio(self):
        with self.assertRaisesRegex(ValueError, "none reached the plurnk agent"):
            driver.PlurnkAgent().mcp_environment()
        stdio = [server("local", None, transport="stdio")]
        with self.assertRaisesRegex(ValueError, "not an HTTP server"):
            driver.PlurnkAgent(mcp_servers=stdio).mcp_environment()

    def test_mcp_alias_collisions_fail_hard(self):
        colliding = [server("file-server", "http://h:1/mcp"), server("File_Server", "http://h:2/mcp")]
        with self.assertRaisesRegex(ValueError, "collide"):
            driver.PlurnkAgent(mcp_servers=colliding).mcp_environment()

    def test_run_is_headless_web_free_and_never_submits_for_the_model(self):
        agent = driver.PlurnkAgent(mcp_servers=BENCH_SERVERS, mcp_host="10.0.0.5", client_timeout_sec=480)
        agent._extra_env = {"PLURNK_MODEL": "deepdumb", "DEEPSEEK_API_KEY": "k"}
        environment = types.SimpleNamespace()

        asyncio.run(agent.run("- List the accounts.", environment, object()))

        self.assertIn("plurnk --json --auto ", environment.command)
        self.assertIn("--flags '{\"noWeb\": true, \"noInteraction\": true}'", environment.command)
        self.assertIn("--project-root '' ", environment.command)
        self.assertIn("--timeout 480 -- '- List the accounts.' ", environment.command)
        self.assertNotIn("submit_agent_response", environment.command)
        self.assertNotIn("git ", environment.command)
        self.assertIn("cp /agent-logs/conversational/responses.jsonl /logs/agent/responses.jsonl", environment.command)
        self.assertIn('snapshot_db "$DB" /logs/agent/plurnk.db', environment.command)
        self.assertEqual(environment.env["PLURNK_MODEL"], "deepdumb")
        self.assertEqual(environment.env["DEEPSEEK_API_KEY"], "k")
        self.assertEqual(environment.env["PLURNK_CLIENT_PROJECT_ROOT"], "")
        self.assertEqual(environment.env["PLURNK_SERVICE_MAX_EMBED_SIZE"], "262144")
        self.assertEqual(environment.env["PLURNK_MCP_CRM"], "http://10.0.0.5:8012/mcp")
        self.assertEqual(environment.env["PLURNK_EXECS_ONLY"], "sh,pm,crm,fileserver")

    def test_run_records_the_exact_mcp_carriage_as_provenance(self):
        agent = driver.PlurnkAgent(mcp_servers=BENCH_SERVERS, mcp_host="10.0.0.5")
        environment = types.SimpleNamespace()

        asyncio.run(agent.run("task", environment, object()))

        self.assertIn("/logs/agent/plurnk-mcp.json", environment.command)
        self.assertIn('"host": "10.0.0.5"', environment.command)
        self.assertIn('"PLURNK_MCP_FILESERVER": "http://10.0.0.5:8013/mcp"', environment.command)
        self.assertIn('"embedCapBytes": 262144', environment.command)
        self.assertNotIn("plurnk-bench.json", environment.command)

    def test_kwargs_survive_harbor_literal_parsing(self):
        # Harbor parses --agent-kwarg values as literals: a numeric-looking host stays a string.
        agent = driver.PlurnkAgent(client_timeout_sec="300", mcp_host=10)

        self.assertEqual(agent._client_timeout_sec, 300)
        self.assertEqual(agent._mcp_host, "10")


if __name__ == "__main__":
    unittest.main()
