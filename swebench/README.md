# swebench

SWE-bench Lite as a fourth bench family beside `deepswe/` (SPEC `§swebench`). It drives
pinned Lite instances through the ordinary plurnk client/service boundary and grades each
attempt with the benchmark's **own official evaluator**, joining its report into the shared
`BenchRecord` exactly as DeepSWE joins Pier's `reward.json`.

Reference context: the [HarnessTax study](https://harnesstax.github.io/) measures 21
model-harness pairs on SWE-bench Lite and Terminal-Bench 2.0; plurnk is a fourth point on
those axes (minimal like Pi, but one compositional op language rather than four tool
schemas).

## toolchain (Phase 0, verified)

The official harness is installed into bench-ignored state, never the repo:

```sh
B="$(git rev-parse --show-toplevel)"
uv venv "$B/.cache/swebench/venv" --python 3.13
uv pip install --python "$B/.cache/swebench/venv/bin/python" swebench datasets
```

`PLURNK_SWEBENCH_PYTHON` overrides the pinned interpreter (default
`<bench>/.cache/swebench/venv/bin/python`). Docker is the harness's only other hard
dependency, and an eval image is several GB: a run refuses to start unless Docker's own
root has `PLURNK_SWEBENCH_MIN_FREE_GB` free (default 15; `0` disables the check), and
`PLURNK_SWEBENCH_PRUNE_IMAGE=1` removes the instance image when the run finishes, trading
a re-pull for the disk.

## pin

```sh
node swebench/pin-task.mjs mwaskom__seaborn-3010
```

writes `swebench/manifests/<instance>.json` from the official dataset: the repository, the
base and environment commits, the eval image, budgets and resource limits, and the
instance's FAIL_TO_PASS / PASS_TO_PASS — plus `datasetRevision`, the dataset's own commit
sha at pin time, so a manifest says which revision it came from.

## corpus

```sh
node swebench/sample.ts --label shape-30 --seed harnesstax-parity-1        # draw 30 ids
node swebench/sample.ts --label shape-30 --mode stratified --pin            # spread across repos, pin manifests
```

The draw is a record (`swebench/corpora/<label>.json`): dataset, label, seed, mode, count,
ids, repo mix. The same seed always yields the same 30 — a declared shape, not parity with
the study until its own trace release names its ids.

## run

```sh
PLURNK_SWEBENCH_CLIENT_ROOT=/path/to/open-client \
  swebench/run.sh --instance mwaskom__seaborn-3010
```

The daemon and client run on the host, so the model endpoint is reached normally; the
model's shell commands are forwarded by PATH shims into one long-lived container of the
instance's eval image (the manifest's network, normally `none`), where the candidate
repository is mounted at its own host path and at `/testbed` — the path the image's editable
install points at, so the model's own tests import its edits. The runner captures the
candidate's diff, writes the Pier-shaped trial directory (`result.json`,
`agent/plurnk.json`, `agent/plurnk.db`, `artifacts/model.patch`), grades with the official
evaluator, and publishes through the shared core. `provenance.json` (instance, model,
dataset and revision, image id, start head, timeout, candidate exit) is written before
publication and rewritten afterwards with the published `runDir`, so an interrupted run
still leaves a described trial. Each attempt takes its own evaluation run id, so two
attempts at one instance under `PLURNK_BENCH_JOBS` never share a container name.

`--preflight` proves the container and the image's login-shell toolchain through
the generated Python shim, including Unicode arguments and stdin, with no model
and no client. `--skip-grading` stops after capture. `--timeout <s>` (or
`PLURNK_SWEBENCH_TIMEOUT_SEC`) sets the client budget; the default is the manifest's
`budgetSeconds` minus 120 s of boot/commit headroom.

The condition (`PLURNK_PROVIDERS_REASONING_<alias>=high`) and the client switches
(`PLURNK_EXECS_QUESTION=0`, `PLURNK_SCHEMES_HTTP_HOSTS=[]`) are ordinary daemon
configuration, exactly as SPEC `§swebench-conditions` and `§swebench-network` state.

## oracle

`swebench/evaluate.ts` is the verifier half: it feeds one patch to the official harness,
reads the per-instance report, and writes `verifier/reward.json` in the shape
`src/ingest.ts` joins.

```sh
node swebench/evaluate.ts --instance mwaskom__seaborn-3010 --patch <file|gold> --out <trialDir>
```

`--patch gold` grades the dataset's own patch: the oracle path with no model.

## status

Phase 0 (the official evaluator on the pinned gold patch) and the family's unit surface are
proven on this host; a full candidate run is the next paid increment. SPEC `§swebench` is
the contract the runner satisfies.
