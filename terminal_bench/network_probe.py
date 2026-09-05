"""Exercise Harbor's real phase policies with unauthenticated HTTPS, never inference.

Run with Harbor's Python environment, from the repository root:
    python -m terminal_bench.network_probe TASK_DIR ALLOWED_URL DENIED_URL \
        --service-version VERSION --client-version VERSION
"""

import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import shlex
import tempfile
from pathlib import Path
from urllib.parse import urlparse

PROBE = r"""
import { lookup } from "node:dns/promises";
import { request } from "node:https";
const urls = JSON.parse(process.argv[1]);
const addresses = JSON.parse(process.argv[2]);
const results = await Promise.all(urls.map(async (url) => {
  const host = new URL(url).hostname;
  let dns;
  try {
    dns = await Promise.race([
      lookup(host, { family: 4 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), 5000)),
    ]);
  } catch (error) { dns = { error: error.code ?? error.message }; }
  let https;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000), redirect: "manual" });
    https = { status: response.status };
    await response.body?.cancel();
  } catch (error) { https = { error: error.cause?.code ?? error.message }; }
  let pinned;
  if (addresses[host]) {
    pinned = await new Promise((resolve) => {
      const req = request(url, {
        lookup: (_host, options, callback) => callback(null,
          options.all ? [{ address: addresses[host], family: 4 }] : addresses[host], 4),
        signal: AbortSignal.timeout(10000),
      }, (response) => { resolve({ status: response.statusCode }); response.destroy(); });
      req.on("error", (error) => resolve({ error: error.code ?? error.message }));
      req.end();
    });
  }
  return { host, dns, https, ...(pinned ? { pinned } : {}) };
}));
console.log(JSON.stringify(results));
process.exit(0);
"""


def failures(evidence):
    """A reachable baseline is required to attribute denials to phase isolation."""
    errors = []
    for record in evidence:
        phase = record["phase"]
        if record["return_code"] != 0:
            errors.append(f"{phase}: probe process exited {record['return_code']}")
            continue
        if len(record["checks"]) != 2:
            errors.append(f"{phase}: missing destination evidence")
            continue
        for index, check in enumerate(record["checks"]):
            expected = phase in ("baseline", "baseline-restored") or (phase == "agent-allowed" and index == 0)
            label = f"{phase}: {check['host']}"
            reached = "status" in check["https"]
            if expected:
                if "address" not in check["dns"]:
                    errors.append(f"{label}: DNS unavailable")
                if not reached:
                    errors.append(f"{label}: HTTPS unavailable")
            elif reached or "status" in check.get("pinned", {}):
                errors.append(f"{label}: HTTPS reachable despite denial")
    if [row["phase"] for row in evidence] != ["baseline", "agent-allowed", "agent-denied", "baseline-restored"]:
        errors.append("incomplete phase evidence")
    return errors


async def run(args):
    from harbor.environments.docker.docker import DockerEnvironment
    from harbor.models.task.task import Task
    from harbor.models.trial.config import AgentConfig, EnvironmentConfig
    from harbor.models.trial.paths import TrialPaths
    from harbor.trial.network_policy import resolve_agent_env_baseline, resolve_agent_phase_policy
    from terminal_bench.plurnk_agent import PlurnkAgent

    task = Task(args.task)
    urls = [args.allowed_url, args.denied_url]
    if any(urlparse(url).scheme != "https" for url in urls):
        raise ValueError("probe URLs must use HTTPS")
    allowed = urlparse(args.allowed_url).hostname
    if allowed == urlparse(args.denied_url).hostname:
        raise ValueError("allowed and denied destinations must differ")
    root = Path(tempfile.mkdtemp(prefix="plurnk-egress-probe-"))
    print(root, flush=True)
    paths = TrialPaths(root)
    paths.mkdir()
    source_hashes = {str(path.relative_to(task.task_dir)): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in sorted(task.task_dir.rglob("*")) if path.is_file()}
    (root / "provenance.json").write_text(json.dumps({
        "harbor": importlib.metadata.version("harbor"),
        "service": args.service_version, "client": args.client_version,
        "allowed_host": allowed, "task_files_sha256": source_hashes,
    }, indent=2) + "\n")
    baseline = resolve_agent_env_baseline(task.config, EnvironmentConfig())
    denied = resolve_agent_phase_policy(task.config, AgentConfig(), baseline)
    if baseline.network_mode != "public" or denied.network_mode != "no-network":
        raise ValueError("probe requires public setup and a no-network agent phase")
    admitted = resolve_agent_phase_policy(
        task.config, AgentConfig(extra_allowed_hosts=[allowed]), baseline,
    )
    environment = DockerEnvironment(
        environment_dir=task.paths.environment_dir,
        environment_name=task.short_name,
        session_id=root.name,
        trial_paths=paths,
        task_env_config=task.config.environment,
        network_policy=baseline,
        phase_network_policies=[denied, admitted],
    )
    evidence = []
    addresses = {}
    try:
        await environment.start(force_build=False)
        agent = PlurnkAgent(
            logs_dir=paths.agent_dir, client_version=args.client_version, service_version=args.service_version,
        )
        await agent.install(environment)
        await environment.download_dir("/logs/agent/setup", paths.agent_dir / "setup")
        for name, policy in [("baseline", baseline), ("agent-allowed", admitted),
                             ("agent-denied", denied), ("baseline-restored", baseline)]:
            await environment.set_network_policy(policy)
            result = await environment.exec(
                command="node --input-type=module -e " + shlex.quote(PROBE)
                + " " + shlex.quote(json.dumps(urls))
                + " " + shlex.quote(json.dumps(addresses)),
                env={"NODE_USE_ENV_PROXY": "1"},
                timeout_sec=35,
            )
            record = {"phase": name, "policy": policy.model_dump(mode="json"), **result.model_dump()}
            if result.return_code == 0:
                record["checks"] = json.loads(result.stdout)
                del record["stdout"]
                if name == "baseline":
                    addresses = {check["host"]: check["dns"]["address"]
                                 for check in record["checks"] if "address" in check["dns"]}
            evidence.append(record)
            print(json.dumps(record), flush=True)
            (root / "network.json").write_text(json.dumps(evidence, indent=2) + "\n")
    finally:
        await environment.stop(delete=True)
    errors = failures(evidence)
    for error in errors:
        print(error, flush=True)
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", type=Path)
    parser.add_argument("allowed_url")
    parser.add_argument("denied_url")
    parser.add_argument("--service-version", required=True)
    parser.add_argument("--client-version", required=True)
    asyncio.run(run(parser.parse_args()))
