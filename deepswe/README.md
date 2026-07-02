# deepswe

First plurnk-bench harness: the [DeepSWE](https://deepswe.datacurve.ai) benchmark (datacurve-ai/deep-swe) — 113 contamination-free, long-horizon tasks run through [Pier](https://github.com/datacurve-ai/pier).

plurnk is wired in as a **Pier agent driver** (`import_path`, no Pier fork). The daemon
(`@plurnk/plurnk-service`) and client (`@plurnk/plurnk`) are bundled into each task's
container as a unit; the driver starts the daemon, points the client at the cloned repo
at `/app`, lets the model EDIT/EXEC, commits the result, and persists the run for ingest.
Pier extracts the committed patch, applies it to a pristine container, and grades it.

```
driver.py    the `plurnk` Pier agent (BaseInstalledAgent subclass)
smoke.sh     carry-manifest runner: forwards an env file to the daemon via --agent-env
```

## reproduce

```
# 1. install Pier + the tasks
git clone https://github.com/datacurve-ai/deep-swe
uv tool install git+https://github.com/datacurve-ai/pier

# 2. write .env — the CARRY MANIFEST for the in-container daemon (see .env.example).
#    Derive it from your daemon config: the model layer (PLURNK_MODEL, the alias def)
#    plus the provider endpoint the alias resolves to. A local llama-server the host
#    reaches on 127.0.0.1 is reached from the container on the host's LAN IP.

# 3. smoke one task, then scale
deepswe/smoke.sh abs-module-cache-flags .env
```

Config reaches the daemon via Pier's `--agent-env` (Pier does **not** interpolate
`${VAR}` in `--config` — its resolver is dead code), which `smoke.sh` assembles from the
env file. Results land in Pier's `jobs/<job>/<trial_id>/` (`verifier/reward.json` + our
`agent/plurnk.json` + `agent/plurnk.db`); `src/ingest.ts` joins them into `BenchRecord`s
and `src/digest.ts` renders each run's forensics into `<trial>/digest/` by reusing the
daemon's own `Digest`.

## status

Proven end-to-end against a live task (`abs-module-cache-flags`): the daemon boots,
drives a real multi-turn loop, commits, and Pier grades the patch — then `readJob →
BenchRecord → renderDigest` produces the per-turn waterfall. gemma-class local models are
expected to fail the oracle (a 0-reward loop is a valid outcome, not an infra error); the
harness's job is to record and forensically digest the run, whatever the score.

Air-gap is off for the diagnostic config (`allow_internet=true`), so the container
reaches the model endpoint directly; the driver's `network_allowlist()` is dormant until
reproducible air-gapped scoring returns (blocked on Pier's squid egress).
