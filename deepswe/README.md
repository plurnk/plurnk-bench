# deepswe

First plurnk-bench harness: the [DeepSWE](https://deepswe.datacurve.ai) benchmark (datacurve-ai/deep-swe) — 113 contamination-free, long-horizon tasks run through [Pier](https://github.com/datacurve-ai/pier).

plurnk is wired in as a **Pier agent driver** (`import_path`, no Pier fork). The daemon
(`@plurnk/plurnk-service`) and client (`@plurnk/plurnk`) are bundled into each task's
container as a unit; the driver starts the daemon, points the client at the cloned repo
at `/app`, lets the model EDIT/EXEC, commits the result, and persists the run for ingest.
Pier extracts the committed patch, applies it to a pristine container, and grades it.

```
driver.py         the `plurnk` Pier agent (BaseInstalledAgent subclass)
job-config.yaml   registers driver.py via import_path
```

## reproduce

```
# 1. install Pier + the tasks
git clone https://github.com/datacurve-ai/deep-swe
uv tool install git+https://github.com/datacurve-ai/pier

# 2. configure the model under test (the bundled DAEMON's config). For local gemma,
#    point at the host llama-server via the gateway:
export PLURNK_MODEL=gemma
export PLURNK_MODEL_gemma=openai/gemma
export PLURNK_BASE_URL=http://host.docker.internal:11435/v1
export PLURNK_MODEL_NAME=plurnk/gemma

# 3. smoke one task (deterministic pick), then scale
PYTHONPATH="$(pwd)/deepswe" pier run -p deep-swe/tasks \
  --config "$(pwd)/deepswe/job-config.yaml" \
  --n-tasks 1 --sample-seed 0 --env docker
```

Results land in Pier's `jobs/<job>/<trial_id>/` (`verifier/reward.json` + our
`agent/plurnk.json` + `agent/plurnk.db`); `src/ingest.ts` joins them into `BenchRecord`s.

## status

Driver written against Pier 0.3.0's API and syntax-valid; **untested against a live
task**. First smoke run verifies: the daemon's lifecycle under `plurnk-service start &`,
container→host endpoint reachability (Linux Docker needs `host.docker.internal` →
host-gateway), and that the committed patch grades. Air-gap is kept; the driver
allowlists only `PLURNK_BASE_URL`'s host.
