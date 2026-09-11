# deepswe

First plurnk-bench harness: the [DeepSWE](https://deepswe.datacurve.ai) benchmark (datacurve-ai/deep-swe) — 113 contamination-free, long-horizon tasks run through [Pier](https://github.com/datacurve-ai/pier).

plurnk is wired in as a **Pier agent driver** (`import_path`, no Pier fork). The daemon
(`@plurnk/plurnk-service`) and client (`@plurnk/plurnk`) are bundled into each task's
container as a unit; the driver starts the daemon, points the client at the cloned repo
at `/app`, lets the model EDIT/EXEC, commits the result, and persists the run for ingest.
Pier extracts the committed patch, applies it to a pristine container, and grades it.

During or after a corpus run, `node deepswe/report.ts <job-directory>` reports
graded pass rate and task-level cost/cache/time medians from the saved whole-workspace
digests. Add `--json` for structured output. Estimates remain explicitly distinct
from provider-billed costs; missing evidence is not replaced with zero.
Usage, cost and cache effectiveness cover model requests across all workers.
To compare the same completed tasks against a saved upstream `trials.json`, add
`--baseline <file> --profile mini_swe_agent_deepseek_v4_flash_max`.

The runner resolves exact current service/client publications before constructing the
agent image, making Docker cache reuse version-sensitive. The driver persists the live
WAL database with `VACUUM INTO`; snapshot failure fails the trial rather than publishing
an incomplete database.

```
driver.py    the `plurnk` Pier agent (BaseInstalledAgent subclass)
smoke.sh     carry-manifest runner: forwards an env file to the daemon via --agent-env
benchlet.sh  pinned host-side diagnostic for one task (SPEC §benchlet-diagnostic)
pair.sh      one task through the benchlet and through mini-swe-agent, one sheet (SPEC §pair-sheet)
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

### one specimen beside mini-swe-agent (#36)

```sh
deepswe/pair.sh --task koota-entity-snapshot-rollback --preflight
PLURNK_MODEL=dumbox deepswe/pair.sh --task koota-entity-snapshot-rollback
```

The pair runner puts the same pinned task through the benchlet and through Pier's
`mini-swe-agent` on the same model route (`deepswe/pair.aliases.json` maps each plurnk
alias to its mini equivalent), one side after the other, under
`~/benchmarks/jobs/pairs/<task>-<alias>-<stamp>/`. `PAIR.md` is a fact sheet read from both
harnesses' `result.json`: both oracle verdicts, tokens, cost, steps and wall time, with
anything a harness did not supply written as absent. The mini trial gets
`<trial>/digest/steps.md`, the trajectory read into per-step actions and observations, so
both sides are read the same way. `--skip-plurnk` / `--skip-mini` run one side;
`--sheet <pair>` rewrites the sheet. See SPEC `§pair-sheet`.

### from clone to one pair on disk

```sh
# 1. siblings: this checkout, ../plurnk-service, ../plurnk (the open client)
git clone <plurnk-bench> && cd plurnk-bench && npm ci
git clone https://github.com/datacurve-ai/deep-swe   # its tasks go under .cache/deep-swe/tasks
                                                       # (or point PLURNK_BENCHLET_TASK_CACHE at them)
uv tool install git+https://github.com/datacurve-ai/pier             # mini's harness
# 2. freeze the trees under test at the published commits (SPEC §bench-relock)
eval "$(deepswe/relock.sh <service-commit> <client-commit>)"
# 3. aliases in ${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env, provider keys in the shell;
#    deepswe/pair.aliases.json maps the alias to mini's route
# 4. pin the task, prove the baseline, then run the pair (a paid run; state the cost shape first)
node deepswe/pin-task.mjs koota-entity-snapshot-rollback
deepswe/pair.sh --task koota-entity-snapshot-rollback --preflight
PLURNK_MODEL=dumbox deepswe/pair.sh --task koota-entity-snapshot-rollback
# 5. read ~/benchmarks/jobs/pairs/<task>-dumbox-<stamp>/PAIR.md, then both digests
```

The confounds a reader should check before believing a pair are listed in SPEC `§bench-confounds`.

### frozen trees for parallel lanes (#9, #19)

The benchlet runs the candidate daemon from source, so the tree under test must
not be the checkout you are editing, and two lanes must not share one build.
Give each run a detached worktree of the exact commit and point the benchlet at
it; run-directory allocation is mkdir-atomic, so lanes never collide:

```sh
eval "$(deepswe/relock.sh <service-sha> <client-sha>)"   # worktrees + npm ci + the two exports
setsid -f deepswe/benchlet.sh --task <task>    # one lane; start more with other tasks
```

`sourceProvenance` refuses a dirty tree (an untracked file inside a tracked
directory counts, #21), so commit the pinned manifests before launching. Find
running lanes with `ps -eo args | grep deepswe/benchlet.ts`.

`PLURNK_BENCHLET_TIMELESS=1` photographs the candidate's working tree at the
budget deadline, lets the run play on to `PLURNK_BENCHLET_TIMELESS_CAP` × budget
(default 2), and grades the deadline photograph beside the final trees.

`--recap <file>` (or `PLURNK_BENCHLET_RECAP`) makes that file the candidate daemon's
Recap footer for this run only: validated in preflight, snapshotted to
`candidate-recap.md`, forwarded as `PLURNK_SERVICE_RECAP`, and recorded with its
sha256 in provenance. Model-facing text is tuned per run this way, never by editing a
tracked source file. A weak-model line for a run under an operator's own GBNF
belongs here rather than in `plurnk-meta/recap.md`.

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
