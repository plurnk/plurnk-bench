"""Harbor agent driver for plurnk on Enterprise-Bench — registered via import path, no fork.

Bundles the plurnk daemon (@plurnk/plurnk-service) and client (@plurnk/plurnk) into the
task image as a unit. ``run()`` starts the daemon with the benchmark's three MCP services
declared as ordinary plurnk HTTP MCP servers, drives one headless loop with the task
instruction as the prompt, and persists the client's ``--json`` record + the daemon DB.
The task's own instruction tells the agent how to submit its answer (one POST to the
container's ``/submit_agent_response``); the model does that itself through ``EXEC [sh]``.
The harness never submits on the model's behalf — an unsubmitted answer is the model's
failure and the benchmark's judge records it as such (SPEC §enterprise-answer).

Run it (enterprise/smoke.sh is the carry-manifest runner):
    enterprise/smoke.sh <task|all> [model-alias]
"""

from __future__ import annotations

import json
import re
import shlex

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# @plurnk/* require Node >= 26 (package.json engines). The Enterprise-Bench base image
# ships Node 22 for Claude Code; NodeSource replaces it during the agent install phase.
NODE_MAJOR = "26"
# Seconds to wait for the daemon's client surface before driving.
DAEMON_READY_TIMEOUT_S = 60
# Default client wall-clock budget per task; override via the `client_timeout_sec` kwarg.
DEFAULT_CLIENT_TIMEOUT_S = 570
# The host name the benchmark's mcp.json uses for its Docker-hosted services.
BENCH_MCP_HOST = "host.docker.internal"
# plurnk MCP server names derive from the env-key suffix and must be [a-z][a-z0-9-]*;
# the alias doubles as the executor tag, so it stays letters and digits only.
ALIAS = re.compile(r"^[a-z][a-z0-9]*$")
# The shell executor is the task's own submission path (its instruction shows curl).
SHELL_RUNTIME = "sh"
# Vector embedding is capped per channel (bytes). The daemon's default is unlimited, and one
# unfiltered SOQL result (8.4 MB, 11,089 records, a single line) held a loop for seven
# minutes of synchronous embedding on the task's two CPUs. Rejection is vector-only: FTS,
# READ, and the graph stay exhaustive over the dump (SPEC §enterprise-posture).
EMBED_CAP_BYTES = 262144


class PlurnkAgent(BaseInstalledAgent):
    """Drives plurnk (daemon + client) against one Enterprise-Bench task."""

    # We emit plurnk's own `--json` record into /logs/agent, not ATIF — scoring reads the
    # benchmark's own reward files; bench ingests the plurnk document beside them.
    SUPPORTS_ATIF: bool = False

    def __init__(
        self,
        client_timeout_sec: int = DEFAULT_CLIENT_TIMEOUT_S,
        client_version: str | None = None,   # npm version spec, e.g. "0.76.2"; None = latest
        service_version: str | None = None,
        mcp_host: str = "",                  # replaces host.docker.internal in MCP URLs (Linux hosts)
        *args,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._client_timeout_sec = int(client_timeout_sec)
        self._client_version = client_version
        self._service_version = service_version
        self._mcp_host = str(mcp_host)

    @staticmethod
    def name() -> str:
        return "plurnk"

    # ---- install: Node + both @plurnk CLIs, baked into the task image ----
    async def install(self, environment: BaseEnvironment) -> None:
        client = f"@plurnk/plurnk@{self._client_version}" if self._client_version else "@plurnk/plurnk@latest"
        service = f"@plurnk/plurnk-service@{self._service_version}" if self._service_version else "@plurnk/plurnk-service@latest"
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail\n"
                "if ! command -v apt-get >/dev/null 2>&1; then\n"
                "  echo 'plurnk driver: unsupported base image (needs apt-get)' >&2; exit 1\n"
                "fi\n"
                "export DEBIAN_FRONTEND=noninteractive\n"
                "apt-get update\n"
                "apt-get install -y curl ca-certificates\n"
                f"curl -fsSL https://deb.nodesource.com/setup_{NODE_MAJOR}.x | bash -\n"
                "apt-get install -y nodejs\n"
                f"npm install -g {shlex.quote(service)} {shlex.quote(client)}\n"
                "command -v plurnk\n"
                "command -v plurnk-service\n"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )

    # ---- MCP: Harbor's declared servers become plurnk's, verbatim but re-hosted ----
    @staticmethod
    def mcp_alias(name: str) -> str:
        alias = re.sub(r"[^a-z0-9]", "", name.lower())
        if not ALIAS.match(alias):
            raise ValueError(f"MCP server name {name!r} yields no usable plurnk alias")
        return alias

    def mcp_environment(self) -> dict[str, str]:
        if not self.mcp_servers:
            raise ValueError("Enterprise-Bench declares its MCP services via --mcp-config; none reached the plurnk agent")
        env: dict[str, str] = {}
        aliases: list[str] = []
        for server in self.mcp_servers:
            if server.transport not in ("streamable-http", "sse") or not server.url:
                raise ValueError(f"MCP server {server.name!r} is not an HTTP server; Enterprise-Bench services are HTTP")
            url = server.url
            if self._mcp_host:
                url = url.replace(BENCH_MCP_HOST, self._mcp_host)
            alias = self.mcp_alias(server.name)
            if alias in aliases:
                raise ValueError(f"MCP server names {server.name!r} collide on plurnk alias {alias!r}")
            aliases.append(alias)
            env[f"PLURNK_MCP_{alias.upper()}"] = url
        env["PLURNK_MCP_ENABLED"] = json.dumps(aliases)
        # Every family document rides turn 0, so the model sees each tool by name.
        env["PLURNK_MCP_EXPANDED"] = json.dumps(aliases)
        # The candidate's executors: the task's MCP services and the shell that submits.
        env["PLURNK_EXECS_ONLY"] = ",".join([SHELL_RUNTIME, *aliases])
        return env

    # Scoring ingests /logs/agent/plurnk.json directly; no ATIF context to populate.
    def populate_context_post_run(self, context: AgentContext) -> None:
        return None

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        escaped = shlex.quote(instruction)
        agent_dir = EnvironmentPaths.agent_dir          # /logs/agent
        record = agent_dir / "plurnk.json"               # client --json document → ingest
        mcp_provenance = agent_dir / "plurnk-mcp.json"   # the exact MCP carriage this run saw
        stderr = agent_dir / "plurnk.client.stderr"
        daemon_log = agent_dir / "plurnk-service.log"
        db_dest = agent_dir / "plurnk.db"                # daemon DB → digest drill-down
        answer_copy = agent_dir / "responses.jsonl"      # the answer the model submitted, if any

        mcp_env = self.mcp_environment()
        # Every --agent-env the runner forwarded (model layer + provider credentials)
        # configures the daemon; the benchmark's MCP carriage and posture ride on top.
        env = {
            **self._extra_env,
            **mcp_env,
            # Headless: no project root, file ops 400. The task is retrieval and an answer.
            "PLURNK_CLIENT_PROJECT_ROOT": "",
            "PLURNK_SERVICE_MAX_EMBED_SIZE": str(EMBED_CAP_BYTES),
        }
        # Enterprise-Bench posture: never interactive, never the open web — the corpus is
        # answerable only through its MCP services. The daemon 403-teaches gated schemes.
        loop_flags = json.dumps({"noWeb": True, "noInteraction": True})
        provenance = {
            "schemaVersion": 1,
            "mcp": {
                "host": self._mcp_host or BENCH_MCP_HOST,
                "servers": {key: value for key, value in mcp_env.items() if key.startswith("PLURNK_MCP_") and key not in ("PLURNK_MCP_ENABLED", "PLURNK_MCP_EXPANDED")},
                "enabled": json.loads(mcp_env["PLURNK_MCP_ENABLED"]),
            },
            "executors": mcp_env["PLURNK_EXECS_ONLY"],
            "embedCapBytes": EMBED_CAP_BYTES,
        }

        # One shell exec: start daemon → wait for the client surface → drive one headless
        # loop → keep the submitted answer beside the record → persist a WAL-safe DB
        # snapshot. A non-answering loop is a valid 0-reward outcome, so the client's exit
        # is tolerated; snapshot failure is not.
        command = f"""
set -uo pipefail
DB="${{PLURNK_SERVICE_DB_PATH:-${{PLURNK_DB_PATH:-${{XDG_DATA_HOME:-$HOME/.local/share}}/plurnk/plurnk.db}}}}"
snapshot_db() {{
  rm -f "$2" "$2-wal" "$2-shm"
  node -e '
    const {{ backup, DatabaseSync }} = require("node:sqlite");
    const source = new DatabaseSync(process.argv[1], {{ readOnly: true }});
    backup(source, process.argv[2])
      .finally(() => source.close())
      .catch((error) => {{ console.error(error); process.exitCode = 1; }});
  ' "$1" "$2"
}}
plurnk-service start > {shlex.quote(str(daemon_log))} 2>&1 &
printf '%s\n' {shlex.quote(json.dumps(provenance))} > {shlex.quote(str(mcp_provenance))}
for _ in $(seq 1 {DAEMON_READY_TIMEOUT_S}); do
  if plurnk models >/dev/null 2>&1; then break; fi
  sleep 1
done
plurnk --json --auto --flags {shlex.quote(loop_flags)} --project-root '' --timeout {self._client_timeout_sec} -- {escaped} \
  > {shlex.quote(str(record))} 2> {shlex.quote(str(stderr))} || true
[ -f /agent-logs/conversational/responses.jsonl ] && cp /agent-logs/conversational/responses.jsonl {shlex.quote(str(answer_copy))}
snapshot_db "$DB" {shlex.quote(str(db_dest))}
"""
        await self.exec_as_agent(environment, command=command, env=env)
