# DeepSWE

Run [DeepSWE](https://github.com/datacurve-ai/deep-swe) tasks through
[Pier](https://github.com/datacurve-ai/pier), or use the host-side benchlet to
investigate one pinned task. The Pier driver installs Plurnk's daemon and client
inside each task container; Pier extracts and grades the committed patch.

Run commands from the repository root after the [shared setup](../README.md#setup).

## Prerequisites

Have Docker available, install Pier, and put the upstream tasks in the cache:

```sh
uv tool install git+https://github.com/datacurve-ai/pier
git clone https://github.com/datacurve-ai/deep-swe .cache/deep-swe
```

Declare your model in `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env` and supply
credentials in the invoking shell. Select it explicitly:

```sh
export PLURNK_MODEL="your-model-alias"
```

Container runs need a provider endpoint reachable from the task container;
host loopback is not container loopback. See
[configuration carriage](../SPEC.md#config-carry-the-runner-carries-authoritative-config-re-declaring-nothing)
for the boundary and the runner's network policy.

## Run through Pier

```sh
deepswe/smoke.sh abs-module-cache-flags
deepswe/smoke.sh all
```

The second command launches the full corpus and can incur substantial inference
cost. Review `PLURNK_BENCH_JOBS`, model settings, and resource limits first.
The runner pins the service/client publications for the launch, prepares task
images, owns the daemon lifecycle, and retains the job's artifacts. Do not start
a separate host daemon for it.

`PLURNK_BENCH_PREFLIGHT=<task>` exercises a named task through the full-corpus
configuration; it is a model run, not a no-inference check. Host-side forensic
tools must understand the database version produced by the selected service.

## Inspect a run

```sh
node deepswe/report.ts /path/to/job
node deepswe/report.ts /path/to/job --json
```

The report joins evaluator verdicts with whole-workspace accounting, including
delegated workers. It reports pass rate and task-level cost/cache/time medians,
with missing telemetry and estimated costs kept visible.

`--baseline <trials.json> --profile <configuration-name>` compares the same
graded tasks with a saved upstream configuration. See
[comparison rules](../SPEC.md#deepswe-report-deepswe-campaign-reporting).

Pier retains `verifier/reward.json`, `agent/plurnk.json`, and
`agent/plurnk.db` per trial. The shared publisher writes a `record.json` and
daemon digest into the retained run directory. Read that evidence before
attributing a miss to either the model or the harness.

## Host-side diagnostic benchlet

The benchlet runs source-built service/client checkouts against one pinned task.
It is an investigation tool, not a canonical DeepSWE score.

Use clean, installed checkouts that will remain unchanged for the run:

```sh
export PLURNK_BENCHLET_SERVICE_ROOT=/path/to/plurnk-service
export PLURNK_BENCHLET_CLIENT_ROOT=/path/to/plurnk
node deepswe/pin-task.mjs abs-module-cache-flags
deepswe/benchlet.sh --task abs-module-cache-flags --preflight
PLURNK_BENCHLET_REQUIEM=0 deepswe/benchlet.sh --task abs-module-cache-flags
```

Pinning snapshots the upstream task and verifier into [benchlet.manifests/](benchlet.manifests/).
Review and commit new manifests before comparing runs. Benchlet `--preflight`
verifies the task and pristine test baseline without calling a model.

The example disables the optional exit interview. To enable it, choose
`PLURNK_BENCHLET_REQUIEM_MODEL` and set `PLURNK_BENCHLET_REQUIEM=1`; that is an
additional model call, accounted separately from task execution. Review other
knobs in [.env.defaults](../.env.defaults).

`--recap <file>` supplies a run-specific context-management footer, captured in
provenance. `PLURNK_BENCHLET_TIMELESS=1` captures and grades the working tree at
the deadline as well as after an extended run; those are distinct results.

For repeatable source lanes, `deepswe/relock.sh <service-ref> <client-ref> [<lanes-root>]`
creates or updates dedicated checkouts and prints their environment exports.
It builds the client against the selected platform's packed contracts, including
unpublished changes, without rewriting source manifests or lockfiles. An optional
lanes root creates an independent pair for comparing two source revisions.
Do not relock lanes while they are running. See
[frozen-lane rules](../SPEC.md#bench-relock-frozen-lanes-move-with-one-command).

## Compare with mini-swe-agent

```sh
deepswe/pair.sh --task koota-entity-snapshot-rollback --preflight
deepswe/pair.sh --task koota-entity-snapshot-rollback
```

The pair runner uses the selected Plurnk alias and its corresponding entry in
[pair.aliases.json](pair.aliases.json). Verify that mapping matches your model
route and effort before launching; the checked-in aliases are examples, not
available credentials or provider accounts.

The runner writes `PAIR.md` beside both attempts, including evaluator verdicts,
tokens, cost, steps, and elapsed time. Missing values stay absent.
`--sheet <pair-directory>` regenerates the comparison without a new run.
See [comparison contract](../SPEC.md#pair-sheet-one-specimen-through-both-harnesses-one-fact-sheet).
