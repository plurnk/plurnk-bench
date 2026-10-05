"""Run one candidate inside Harbor's task environment; no agent loop or oracle."""

import asyncio
import hashlib
import importlib.metadata
import json
import logging
import shlex
import signal
import sys
from pathlib import Path

# {§swebench-model-account} — the account the model's commands run as inside the task container.
MODEL_ACCOUNT = "plurnk-model"
MODEL_UID = 60007
MODEL_HOME = "/tmp/plurnk-model"


def redacted(message, env):
    for value in sorted(set(env.values()), key=len, reverse=True):
        if len(value) >= 8:
            message = message.replace(value, "[redacted]")
    return message


class EnvironmentFormatter(logging.Formatter):
    def __init__(self, env):
        super().__init__("Harbor %(levelname)s: %(message)s")
        self.env = env

    def format(self, record):
        return redacted(super().format(record), self.env)


def resolver_configuration(root, source):
    """Use Harbor's supported Compose overlay without changing its topology."""
    if not source:
        return [], None
    source = Path(source).resolve(strict=True)
    if not source.is_file():
        raise ValueError("resolver configuration must be a file")
    content = source.read_bytes()
    snapshot = root / "resolv.conf"
    snapshot.write_bytes(content)
    mount = {"type": "bind", "source": str(snapshot),
             "target": "/etc/resolv.conf", "read_only": True}
    overlay = root / "resolver-compose.json"
    overlay.write_text(json.dumps({"services": {
        service: {"volumes": [mount]}
        for service in ("main", "harbor-docker-egress-control-sidecar")
    }}, indent=2) + "\n")
    return [overlay], {"source": str(source), "sha256": hashlib.sha256(content).hexdigest()}


def configuration(request):
    """Candidate data mounts never expose the benchmark checkout."""
    hosts = request["allowedHosts"]
    if not isinstance(hosts, list) or any(not isinstance(host, str) or not host for host in hosts):
        raise ValueError("allowedHosts must be a list of nonempty host names")
    if not hosts and not request.get("preflight", False):
        raise ValueError("a model run requires an explicit model-host allowlist")
    mounts = []
    for name, target, readonly in [
        ("runtime", "/opt/harness", True),
        ("repository", "/testbed", False),
        ("agent", "/logs/agent", False),
    ]:
        source = Path(request[name]).resolve(strict=True)
        if not source.is_dir():
            raise ValueError(f"{name} is not a directory")
        mounts.append({"type": "bind", "source": str(source), "target": target, "read_only": readonly})
    return mounts, {"network_mode": "allowlist" if hosts else "no-network", "allowed_hosts": hosts}


async def run(request):
    from harbor.environments.docker.docker import DockerEnvironment
    from harbor.models.task.config import EnvironmentConfig, NetworkPolicy, normalize_allowed_hosts
    from harbor.models.trial.paths import TrialPaths

    mounts, policy = configuration(request)
    policy["allowed_hosts"] = normalize_allowed_hosts(policy["allowed_hosts"])
    root = Path(request["trial"])
    paths = TrialPaths(root / "harbor")
    paths.mkdir()
    environment_dir = root / "environment"
    environment_dir.mkdir()
    compose, resolver = resolver_configuration(root, request.get("resolverConfig", ""))
    # Backend errors may include exec environment arguments. Preserve failures,
    # including best-effort teardown warnings, without their credential values.
    logger = logging.getLogger(root.name)
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(EnvironmentFormatter(request["env"]))
    logger.addHandler(handler)
    logger.setLevel(logging.WARNING)
    logger.propagate = False
    environment = DockerEnvironment(
        environment_dir=environment_dir, environment_name="swebench-candidate",
        session_id=root.name, trial_paths=paths, logger=logger,
        task_env_config=EnvironmentConfig(
            docker_image=request["image"], cpus=request["cpus"],
            memory_mb=request["memoryMb"], workdir="/testbed",
        ), mounts=mounts, network_policy=NetworkPolicy(**policy),
        extra_docker_compose=compose,
    )
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(name, task.cancel)
    started = False
    try:
        await environment.start(force_build=False)
        started = True
        # {§swebench-model-account} — the model's commands run as an account of their own, so the daemon's
        # evidence under /logs/agent and the harness bundle under /opt/harness are not theirs to read: the
        # evidence folder closes to its owner, the bundle is the host's at 0700 already. The trial copy
        # belongs to that account, group-writable with set-group-id directories, so what the daemon writes
        # there (umask 002) stays writable to the model's commands and the daemon's git keeps reading it.
        # Harbor restores host ownership of writable mounts during teardown.
        ownership = await environment.exec(command=(
            f'useradd --system --uid {MODEL_UID} --user-group --home-dir {MODEL_HOME} --shell /bin/bash {MODEL_ACCOUNT} 2>/dev/null; '
            f'getent passwd {MODEL_ACCOUNT} >/dev/null && mkdir -p {MODEL_HOME} && chown {MODEL_ACCOUNT}:{MODEL_ACCOUNT} {MODEL_HOME} && chmod 700 {MODEL_HOME} '
            f'&& chown -R {MODEL_ACCOUNT}:{MODEL_ACCOUNT} /testbed && chmod -R g+w /testbed && find /testbed -type d -exec chmod g+s {{}} + '
            '&& chmod 700 /logs/agent && git config --system safe.directory "*"'))
        if ownership.return_code != 0:
            raise RuntimeError(f"Cannot provision the model account over the candidate repository: {ownership.stdout or ownership.stderr}")
        record = {
            "adapter": "container-native", "harbor": importlib.metadata.version("harbor"),
            "image": request["image"], "projectRoot": "/testbed", "network": policy,
            "mounts": mounts, "cpus": request["cpus"], "memoryMb": request["memoryMb"],
            **({"resolver": resolver} if resolver else {}),
        }
        (root / "candidate-execution.json").write_text(json.dumps(record, indent=2) + "\n")
        argv = ["/opt/harness/bin/node", "/opt/harness/runner.mjs", *request["argv"]]
        # bash -l activates the specimen's own conda environment. Only Node is
        # added ahead of it, identically for both candidates.
        # Read the image's login files BEFORE assigning the isolated candidate
        # home. Otherwise SWE-bench's conda activation silently disappears.
        command = (
            "umask 002; export PATH=/opt/harness/bin:$PATH HOME=/tmp/harness-home "
            "XDG_CONFIG_HOME=/tmp/harness-home/.config "
            "XDG_DATA_HOME=/tmp/harness-home/.local/share "
            "XDG_STATE_HOME=/tmp/harness-home/.local/state "
            "XDG_CACHE_HOME=/tmp/harness-home/.cache; exec " + shlex.join(argv)
        )
        env = {
            **request["env"], "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
            "NODE_OPTIONS": "", "NODE_USE_ENV_PROXY": "1",
            "PLURNK_EXECS_SPAWN_USER": MODEL_ACCOUNT,  # {§swebench-model-account}
        }
        result = await environment.exec(command="bash -lc " + shlex.quote(command), cwd="/testbed", env=env)
        (Path(request["agent"]) / "runtime.log").write_text(result.stdout or result.stderr or "")
        if result.return_code != 0:
            # Runner diagnostics contain no credential-bearing command line.
            sys.stderr.write(result.stdout or result.stderr or "candidate exited without diagnostics\n")
        return result.return_code
    except asyncio.CancelledError:
        if started:
            # Signal the supervisor, not every process by a shared name. Its
            # finally block stops the daemon and writes a consistent digest.
            await environment.exec(command=(
                "if test -f /logs/agent/runner.pid; then "
                "kill -TERM $(cat /logs/agent/runner.pid); "
                "for i in $(seq 1 60); do test ! -f /logs/agent/runner.pid && exit 0; sleep 1; done; fi"
            ), timeout_sec=65)
        return 143
    finally:
        await environment.stop(delete=True)


def main():
    request = json.load(sys.stdin)
    try:
        return asyncio.run(run(request))
    except Exception as error:
        # Preserve the failure cause without exposing env values in backend errors.
        message = redacted(str(error), request.get("env", {}))
        sys.stderr.write(f"{type(error).__name__}: {message}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
