"""Pier agent driver for plurnk — registered via ``import_path``, no Pier fork.

Bundles the plurnk daemon (@plurnk/plurnk-service) and client (@plurnk/plurnk) into
the task image as a unit. ``run()`` starts the daemon, points the client at the
cloned repo at ``/app`` with the task instruction as the prompt, lets the model
EDIT/EXEC, commits the result, and persists the client's ``--json`` record + the
daemon DB for later ingest. Pier extracts the committed patch and grades it.

Run it (deepswe/smoke.sh is the carry-manifest runner):
    deepswe/smoke.sh <task-glob> <env-file>

Config reaches the in-container daemon via ``--agent-env`` (Pier does NOT interpolate
``${VAR}`` in ``--config`` — that resolver is dead code). Proven end-to-end against a
live task: the daemon boots, drives a real multi-turn loop, commits, and grades.
"""

from __future__ import annotations

import shlex
from urllib.parse import urlparse

from pier.agents.installed.base import BaseInstalledAgent, with_prompt_template
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep
from pier.models.agent.network import NetworkAllowlist
from pier.models.trial.paths import EnvironmentPaths

# @plurnk/* require Node >= 26 (package.json engines). Installed from NodeSource on
# the BUILD network, which is available even for allow_internet=false tasks.
NODE_MAJOR = "26"
# Seconds to wait for the daemon's WebSocket to accept client calls before driving.
DAEMON_READY_TIMEOUT_S = 60
# Default client wall-clock budget per task; override via the `client_timeout_sec` kwarg.
DEFAULT_CLIENT_TIMEOUT_S = 1800


class PlurnkAgent(BaseInstalledAgent):
    """Drives plurnk (daemon + client) against one Pier task."""

    # We emit plurnk's own `--json` record into /logs/agent, not ATIF — scoring
    # reads that artifact directly rather than Pier's trajectory context.
    SUPPORTS_ATIF: bool = False

    def __init__(
        self,
        client_timeout_sec: int = DEFAULT_CLIENT_TIMEOUT_S,
        client_version: str | None = None,   # npm version spec, e.g. "0.40.2"; None = latest
        service_version: str | None = None,
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

    # NB: the @plurnk CLIs lack `--version` and use strict parseArgs, so an unknown
    # flag is a hard ERR_PARSE_ARGS_UNKNOWN_OPTION crash — we verify install by
    # presence on PATH, not by invoking the arg parser. (Objective-2 finding: the
    # CLIs should support `--version`; surfaced to the client/service.)

    # ---- install: Node + both @plurnk CLIs, baked into the task image ----
    def install_spec(self) -> AgentInstallSpec:
        client = f"@plurnk/plurnk@{self._client_version}" if self._client_version else "@plurnk/plurnk@latest"
        service = f"@plurnk/plurnk-service@{self._service_version}" if self._service_version else "@plurnk/plurnk-service@latest"
        run = (
            "set -euo pipefail\n"
            "if ! command -v apt-get >/dev/null 2>&1; then\n"
            "  echo 'plurnk driver: unsupported base image (needs apt-get)' >&2; exit 1\n"
            "fi\n"
            "export DEBIAN_FRONTEND=noninteractive\n"
            "apt-get update\n"
            "apt-get install -y curl ca-certificates git\n"
            f"curl -fsSL https://deb.nodesource.com/setup_{NODE_MAJOR}.x | bash -\n"
            "apt-get install -y nodejs\n"
            # global install needs root; the agent user runs the bins off PATH at runtime
            f"npm install -g {shlex.quote(service)} {shlex.quote(client)}\n"
            "command -v plurnk\n"
            "command -v plurnk-service\n"
        )
        return AgentInstallSpec(
            agent_name=self.name(),
            version=self._version,
            steps=[InstallStep(user="root", env={"DEBIAN_FRONTEND": "noninteractive"}, run=run)],
            verification_command="command -v plurnk && command -v plurnk-service",
        )

    # ---- runtime egress: only the model endpoint the daemon calls ----
    def network_allowlist(self) -> NetworkAllowlist:
        # Air-gap is kept (reproducibility-honest). The daemon's only outbound need
        # is its model endpoint — allowlist exactly that host, derived from the
        # operator-configured PLURNK_BASE_URL (mirrors Pier's built-in drivers).
        domains: list[str] = []
        base_url = self._get_env("PLURNK_BASE_URL")
        if base_url:
            host = urlparse(base_url).hostname
            if host:
                domains.append(host)
        return NetworkAllowlist(domains=domains)

    # Scoring ingests /logs/agent/plurnk.json directly; no ATIF context to populate.
    def populate_context_post_run(self, context: AgentContext) -> None:
        return None

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        escaped = shlex.quote(instruction)
        agent_dir = EnvironmentPaths.agent_dir          # /logs/agent
        record = agent_dir / "plurnk.json"               # client --json document → ingest
        stderr = agent_dir / "plurnk.client.stderr"
        daemon_log = agent_dir / "plurnk-service.log"
        db_dest = agent_dir / "plurnk.db"                # daemon DB → digest drill-down

        # All PLURNK_* the operator set in the job config's env: flow through here
        # (build_process_env merges self._extra_env), configuring the daemon.
        env = self.build_process_env({"PLURNK_PROJECT_ROOT": "/app"})

        # One shell exec: start daemon → wait for WS → drive client at /app → commit
        # so `git diff base..HEAD` (Pier's pre_artifacts.sh) captures the work →
        # persist the DB. A non-solving loop is a valid 0-reward outcome, not an infra
        # error, so the client's exit is tolerated; install/commit failures are not.
        command = f"""
set -uo pipefail
plurnk-service start > {shlex.quote(str(daemon_log))} 2>&1 &
for _ in $(seq 1 {DAEMON_READY_TIMEOUT_S}); do
  if plurnk models >/dev/null 2>&1; then break; fi
  sleep 1
done
plurnk --json --yolo --project-root /app --timeout {self._client_timeout_sec} {escaped} \
  > {shlex.quote(str(record))} 2> {shlex.quote(str(stderr))} || true
cd /app
git add -A
git -c user.email=plurnk@bench.local -c user.name=plurnk commit -q -m "plurnk solution" || true
cp "${{PLURNK_SERVICE_DB_PATH:-${{PLURNK_DB_PATH:-$HOME/.plurnk/plurnk.db}}}}" {shlex.quote(str(db_dest))} 2>/dev/null || true
"""
        await self.exec_as_agent(environment, command=command, env=env)
