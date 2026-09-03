# deepswe

First plurnk-bench harness: the [DeepSWE](https://deepswe.datacurve.ai) benchmark (datacurve-ai/deep-swe) — 113 contamination-free, long-horizon tasks run through [Pier](https://github.com/datacurve-ai/pier).

plurnk is wired in as a **Pier agent driver** (`import_path`, no Pier fork). The daemon
(`@plurnk/plurnk-service`) and client (`@plurnk/plurnk`) are bundled into each task's
container as a unit; the driver starts the daemon, points the client at the cloned repo
at `/app`, lets the model EDIT/EXEC, commits the result, and persists the run for ingest.
Pier extracts the committed patch, applies it to a pristine container, and grades it.
The runner resolves exact current service/client publications before constructing the
agent image, making Docker cache reuse version-sensitive. The driver persists the live
WAL database with `VACUUM INTO`; snapshot failure fails the trial rather than publishing
an incomplete database.

```
driver.py    the `plurnk` Pier agent (BaseInstalledAgent subclass)
smoke.sh     carry-manifest runner: forwards an env file to the daemon via --agent-env
```

## reproduce

```
# 1. install Pier + the tasks
git clone https://github.com/datacurve-ai/deep-swe
uv tool install git+https://github.com/datacurve-ai/pier

# 2. Declare reusable aliases in ${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env
#    and provider endpoints/credentials in the invoking shell. PLURNK_MODEL follows
#    the ordinary shell → XDG → committed-default cascade.

# 3. smoke one task, then scale
PLURNK_MODEL=deepdumb deepswe/smoke.sh abs-module-cache-flags
```

## iterative diagnostic

Use the checked-in benchlet when changing Plurnk and repeatedly inspecting one
pinned external task without Pier's full container ceremony:

```sh
export PLURNK_BENCHLET_CLIENT_ROOT=/path/to/open-client
# the release gate: the two FrontierHarness specimens (#22), preflight first
deepswe/benchlet.sh --task sqlite-db-truncate --preflight
PLURNK_MODEL=kimi deepswe/benchlet.sh --task sqlite-db-truncate
deepswe/benchlet.sh --task fastapi-deprecation-response-headers --preflight
PLURNK_MODEL=kimi PLURNK_BENCHLET_TIMELESS=1 deepswe/benchlet.sh --task fastapi-deprecation-response-headers
# any other pinned task
PLURNK_MODEL=glm deepswe/benchlet.sh --task happy-dom-abort-pending-body-reads
```

`PLURNK_BENCHLET_TIMELESS=1` photographs the candidate's working tree at the
budget deadline, lets the run play on to `PLURNK_BENCHLET_TIMELESS_CAP` × budget
(default 2), and grades the deadline photograph beside the final trees.

`--recap <file>` (or `PLURNK_BENCHLET_RECAP`) makes that file the candidate daemon's
Recap footer for this run only: validated in preflight, snapshotted to
`candidate-recap.md`, forwarded as `PLURNK_SERVICE_RECAP`, and recorded with its
sha256 in provenance. Model-facing text is tuned per run this way, never by editing a
tracked source file. The weak-model line for GBNF runs ({§gbnf-forced-march}) belongs
here rather than in `plurnk-meta/recap.md`.

The outside client checkout is an explicit precondition. The harness never
guesses a sibling under the shared parent directory.

A task must be pinned before the benchlet will run it. Terminal-Bench 2.1 tasks pin from
`.cache/terminal-bench-2-1` with `node deepswe/pin-task.mjs --terminal-bench <task>...` (image,
budgets, and resources from task.toml; the tree is graded by the task's own test.sh, see SPEC
§benchlet-tree). DeepSWE: `node deepswe/pin-task.mjs <task>...`
derives the manifest from the task cache (`.cache/deep-swe/tasks/<task>`): repository and
base commit from the environment Dockerfile (the full commit read from the pinned image),
the task image by `ext_id`, the task verifier, and the sha256 of every snapshotted file.

The `--preflight` form verifies the selected task, upstream commit, official
verifier, and pristine p2p/f2p baseline without calling a model. A model run
builds the clean service and client revisions, runs the task once, grades both
the complete working tree and the committed submission, digests every packet
and provider attempt, and obtains an independent requiem. Docker-backed tasks
reuse their pinned task image for the candidate checkout and canonical
verifier. Results land in a flat sibling directory such as
`../benchmarks/run47-deepswe-happy-dom-abort-pending-body-reads-glm/`.

This is a diagnostic oracle, not a canonical DeepSWE score. Pier remains the
publication path. See SPEC `§benchlet-diagnostic`.

Config reaches the daemon via Pier's `--agent-env` (Pier does **not** interpolate
`${VAR}` in `--config` — its resolver is dead code), which `smoke.sh` assembles from the
env file. Results land in Pier's `jobs/<job>/<trial_id>/` (`verifier/reward.json` + our
`agent/plurnk.json` + `agent/plurnk.db`); `src/ingest.ts` joins them into `BenchRecord`s
and `src/digest.ts` renders each run's forensics into `<trial>/digest/` by reusing the
daemon's own `Digest`.

Configured Tavily follows ordinary provider carriage; no key remains the default.
Artifacts record only its configured/absent state and effective search depth.

## status

Proven end-to-end against a live task (`abs-module-cache-flags`): the daemon boots,
drives a real multi-turn loop, commits, and Pier grades the patch — then `readJob →
BenchRecord → renderDigest` produces the per-turn waterfall. gemma-class local models are
expected to fail the oracle (a 0-reward loop is a valid outcome, not an infra error); the
harness's job is to record and forensically digest the run, whatever the score.

Air-gap is off for the diagnostic config (`allow_internet=true`), so the container
reaches the model endpoint directly; the driver's `network_allowlist()` is dormant until
reproducible air-gapped scoring returns (blocked on Pier's squid egress).
