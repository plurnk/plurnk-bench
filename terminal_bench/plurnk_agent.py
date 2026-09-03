"""Harbor installed-agent for plurnk — the Terminal-Bench 4.0 family (#13/#16).

Port of the proven DeepSWE Pier driver (deepswe/driver.py) to Harbor's
BaseInstalledAgent: install Node >= 26 plus the published @plurnk pair into the
task container, boot the daemon, drive one client one-shot with the task
instruction as the prompt, and persist the client --json record plus a WAL-safe
daemon DB snapshot into /logs/agent for forensics.

Config reaches the in-container daemon by explicit forwarding (the #11 lesson):
the model layer for the selected alias — its definition, alias-scoped knobs,
provider-scoped knobs, and the provider's registered credentials — never the
whole host environment.

Run one task:
    harbor run -p .cache/terminal-bench/tasks/<task> \
        -m fireox --agent terminal-bench.plurnk_agent:PlurnkAgent
"""

from __future__ import annotations

import functools
import json
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# @plurnk/* require Node >= 26 (package.json engines — the enterprise-image lesson).
NODE_MAJOR = "26"
DAEMON_READY_TIMEOUT_S = 60
# TB 4.0 calibrates every task to a FLAT 8h agent budget. §config-budget: a shorter
# client timeout starves the model below the benchmark's allowance and understates
# every result — the default matches the calibrated budget minus headroom for
# install/boot/snapshot. Bounded specimens override via the client_timeout_sec kwarg.
DEFAULT_CLIENT_TIMEOUT_S = 28_200

_PROVIDERS_JSON = (
    Path(__file__).resolve().parent.parent
    / "node_modules" / "@plurnk" / "plurnk-models" / "dist" / "providers.json"
)


def _prefix(provider_id: str) -> str:
    """Provider id -> env prefix, the catalog-id sanitization rule (#459)."""
    return re.sub(r"[^A-Za-z0-9]", "_", provider_id).upper()


@functools.cache
def _operator_env() -> dict[str, str]:
    """The operator XDG config, parsed with the daemon's own parseEnv semantics.

    The authoritative model layer lives in this FILE, not the shell (SPEC
    §config-carry) — reading it here makes the agent launchable bare, with no
    wrapper step to remember.
    """
    config_home = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    path = Path(config_home) / "plurnk" / ".env"
    if not path.is_file():
        return {}
    out = subprocess.run(
        ["node", "-e",
         'const { parseEnv } = require("node:util");'
         'process.stdout.write(JSON.stringify(parseEnv('
         'require("node:fs").readFileSync(process.argv[1], "utf8"))));',
         str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


class PlurnkAgent(BaseInstalledAgent):
    """Drives plurnk (daemon + client) against one Terminal-Bench task."""

    def __init__(
        self,
        client_timeout_sec: int = DEFAULT_CLIENT_TIMEOUT_S,
        client_version: str | None = None,   # npm spec, e.g. "0.81.0"; None = latest
        service_version: str | None = None,  # npm spec, e.g. "1.14.0"; None = latest
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._client_timeout_sec = int(client_timeout_sec)
        self._client_version = client_version
        self._service_version = service_version

    @staticmethod
    def name() -> str:
        return "plurnk"

    # The @plurnk CLIs use strict parseArgs with no --version; verify by PATH presence.
    @override
    async def install(self, environment: BaseEnvironment) -> None:
        client = f"@plurnk/plurnk@{self._client_version or 'latest'}"
        service = f"@plurnk/plurnk-service@{self._service_version or 'latest'}"
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail\n"
                "if ! command -v apt-get >/dev/null 2>&1; then\n"
                "  echo 'plurnk agent: unsupported base image (needs apt-get)' >&2; exit 1\n"
                "fi\n"
                "export DEBIAN_FRONTEND=noninteractive\n"
                "apt-get update\n"
                "apt-get install -y curl ca-certificates git\n"
                f"curl -fsSL https://deb.nodesource.com/setup_{NODE_MAJOR}.x | bash -\n"
                "apt-get install -y nodejs\n"
                f"npm install -g {shlex.quote(service)} {shlex.quote(client)}\n"
                # Identity provisioning (#460): tasks may drive git; an identity-less
                # container turns every commit into harness friction.
                "git config --system user.name plurnk-candidate\n"
                "git config --system user.email candidate@plurnk.invalid\n"
                "command -v plurnk\n"
                "command -v plurnk-service\n"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    def _host_env(self, key: str) -> str | None:
        """extra_env > process env > operator XDG file — one resolution order."""
        value = self._get_env(key)
        if value is not None:
            return value
        return _operator_env().get(key)

    def _host_env_by_pattern(self, matcher) -> dict[str, str]:
        merged = {**_operator_env(), **os.environ, **self._extra_env}
        return {k: v for k, v in merged.items() if matcher(k)}

    def _model_env(self) -> dict[str, str]:
        """The minimal manifest (#11): the alias's model layer, nothing else.

        PLURNK_MODEL comes from harbor's -m (an alias or a full provider/model
        route); the alias definition, alias-scoped knobs, provider-scoped knobs,
        and the provider's registered credentials ride with it. Fail-hard on an
        unresolvable provider — a silent boot with no model is a 113x0 rerun.
        """
        model = self.model_name or self._host_env("PLURNK_MODEL")
        if not model:
            raise ValueError("plurnk agent needs -m <alias-or-route> or PLURNK_MODEL")
        env: dict[str, str] = {"PLURNK_MODEL": model}

        definition = self._host_env(f"PLURNK_MODEL_{model}")
        if definition:
            env[f"PLURNK_MODEL_{model}"] = definition
        route = definition or (model if "/" in model else None)
        if route is None:
            raise ValueError(
                f"alias {model!r} has no PLURNK_MODEL_{model} definition on the host"
            )

        alias_re = re.compile(rf"PLURNK_(MODEL|PROVIDERS_[A-Z_]+)_{re.escape(model)}$")
        env.update(self._host_env_by_pattern(lambda k: alias_re.fullmatch(k) is not None))

        provider_id = route.split("/")[0]
        prefix = _prefix(provider_id)
        env.update(self._host_env_by_pattern(
            lambda k: k.startswith(f"PLURNK_PROVIDERS_PROVIDER_{prefix}_")))

        providers = json.loads(_PROVIDERS_JSON.read_text())
        provider = providers.get(provider_id)
        if provider is None:
            raise ValueError(f"unknown provider {provider_id!r} in route {route!r}")
        for credential in provider.get("env", []):
            value = self._host_env(credential)
            if value:
                env[credential] = value

        base_url = self._host_env(f"PLURNK_BASEURL_{model}") or self._host_env("PLURNK_BASE_URL")
        if base_url:
            env[f"PLURNK_BASEURL_{model}"] = base_url
        env.update(self._embedding_env())
        return env

    def _embedding_env(self) -> dict[str, str]:
        """ONE embedding route rides (SPEC §config-embedding-route, as deepswe/smoke.sh).

        Absent or `bundled` → an explicit empty selection, the daemon's structural
        bundled wasm fallback (the ruling: no CPU contention worth a hosted line). A
        hosted route forwards the openai-compatible provider lines for its prefix; the
        operator's own PLURNK_EMBEDDING_* never rides.
        """
        route = self._host_env("PLURNK_BENCH_EMBEDDING_ROUTE") or "bundled"
        if route == "bundled":
            return {"PLURNK_EMBEDDING_MODEL": ""}
        base_url = self._host_env("PLURNK_BENCH_EMBEDDING_BASE_URL")
        if not base_url:
            raise ValueError(
                f"embedding route {route!r} needs PLURNK_BENCH_EMBEDDING_BASE_URL on the host"
            )
        prefix = _prefix(route.split("/")[0])
        return {
            "PLURNK_EMBEDDING_MODEL": route,
            f"PLURNK_PROVIDERS_PROVIDER_{prefix}_NPM": "@ai-sdk/openai-compatible",
            f"PLURNK_PROVIDERS_PROVIDER_{prefix}_BASE_URL": base_url,
        }

    def populate_context_post_run(self, context: AgentContext) -> None:
        return None

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        escaped = shlex.quote(instruction)
        agent_dir = EnvironmentPaths.agent_dir
        record = agent_dir / "plurnk.json"
        stderr = agent_dir / "plurnk.client.stderr"
        daemon_log = agent_dir / "plurnk-service.log"
        db_dest = agent_dir / "plurnk.db"

        env = self._model_env()
        env["NODE_USE_ENV_PROXY"] = "1"

        # No web route -> the capability ceiling removes web tools and their
        # teaching (contamination honesty, the DeepSWE posture).
        capability_args = ""
        if not self._host_env("TAVILY_API_KEY"):
            deny_web = json.dumps({"deny": [{"traits": ["web"]}]})
            capability_args = f"--capabilities {shlex.quote(deny_web)} "

        # One shell exec: daemon up -> AG-UI ready -> client one-shot in the task's
        # own WORKDIR -> WAL-safe DB snapshot. A non-solving loop is a valid zero;
        # a missing snapshot is not.
        command = f"""
set -uo pipefail
mkdir -p {shlex.quote(str(agent_dir))}
# A task directory outside any repository has no tracked members ({{§membership-baseline}}): admit its
# tree as service configuration so READ, FIND, and EDIT see it. Inside a repository, tracked-only stands.
if ! git -C "$PWD" rev-parse --show-toplevel >/dev/null 2>&1; then
  export PLURNK_MEMBERS_TASK='**' PLURNK_MEMBERS_ENABLED='["task"]'
fi
DB="${{PLURNK_SERVICE_DB_PATH:-${{PLURNK_DB_PATH:-${{XDG_DATA_HOME:-$HOME/.local/share}}/plurnk/plurnk.db}}}}"
plurnk-service start > {shlex.quote(str(daemon_log))} 2>&1 &
for _ in $(seq 1 {DAEMON_READY_TIMEOUT_S}); do
  if plurnk models >/dev/null 2>&1; then break; fi
  sleep 1
done
plurnk --json --auto {capability_args}--project-root "$PWD" --timeout {self._client_timeout_sec} -- {escaped} \
  > {shlex.quote(str(record))} 2> {shlex.quote(str(stderr))} || true
node -e '
  const {{ backup, DatabaseSync }} = require("node:sqlite");
  const source = new DatabaseSync(process.argv[1], {{ readOnly: true }});
  backup(source, process.argv[2])
    .finally(() => source.close())
    .catch((error) => {{ console.error(error); process.exitCode = 1; }});
' "$DB" {shlex.quote(str(db_dest))}
"""
        await self.exec_as_agent(environment, command=command, env=env)
