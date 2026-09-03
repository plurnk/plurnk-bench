import importlib
import sys
import types
import unittest
from pathlib import PurePosixPath


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


if __name__ == "__main__":
    unittest.main()
