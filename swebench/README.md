# SWE-bench Lite

Run pinned repository issues through Plurnk and grade their patches with the
[official SWE-bench evaluator](https://github.com/SWE-bench/SWE-bench).
See [SPEC.md](../SPEC.md#swebench-swe-bench-lite-and-native-harness-comparisons)
for isolation, provenance, and comparison contracts.

Run commands from the repository root after the [shared setup](../README.md#setup).

## Prerequisites

Install the evaluator into the ignored cache, and have Docker running:

```sh
uv venv .cache/swebench/venv --python 3.13
uv pip install --python .cache/swebench/venv/bin/python swebench datasets harbor==0.23.0
```

`PLURNK_SWEBENCH_PYTHON` selects a different interpreter. Container images need
substantial disk space; the runner checks Docker's storage before launching.
`PLURNK_SWEBENCH_HARBOR_PYTHON` selects the interpreter containing Harbor (default
`python`). The candidate also needs a Linux x64 host's Node 26+ distribution and npm;
the runner provisions the same Node runtime for Plurnk and Pi inside the image.

Select clean, installed service and client checkouts and your configured model:

```sh
export PLURNK_SWEBENCH_SERVICE_ROOT=/path/to/plurnk-service
export PLURNK_SWEBENCH_CLIENT_ROOT=/path/to/plurnk
export PLURNK_MODEL="your-model-alias"
export PLURNK_SWEBENCH_HARBOR_PYTHON="$PWD/.cache/swebench/venv/bin/python"
export PLURNK_SWEBENCH_MODEL_HOSTS='["your.model.endpoint"]'
```

Credentials stay in the invoking environment. Do not edit or rebuild the
candidate checkouts while a campaign uses them.

## One task

```sh
node swebench/pin-task.mjs mwaskom__seaborn-3010
swebench/run.sh --instance mwaskom__seaborn-3010 --preflight
swebench/run.sh --instance mwaskom__seaborn-3010
```

Pinning records the dataset revision, repository commits, evaluation image,
tests, and resource limits in [manifests/](manifests/). Review and commit a new
manifest before using it for a comparison.

`--preflight` checks the container and its execution environment without calling
a model. The whole candidate—including native file tools and executor discovery—
runs inside the task container at `/testbed`. Harbor allows only the explicitly
listed model hosts; empty means no external network and is valid for preflight.
Local endpoints must already use a container-reachable address; no route is
silently rewritten. The official verifier remains separate and unchanged.

If Docker's embedded DNS cannot resolve names under the allowlist, set
`PLURNK_SWEBENCH_RESOLV_CONF` to a resolver file containing DNS servers reachable
from the container (not a host-loopback stub). Harbor and the candidate receive
the same read-only snapshot; each trial keeps its private network and allowlist.
The source and hash are recorded in `candidate-execution.json`.

Clean source builds are packed and installed into a read-only runtime bundle,
cached under `~/benchmarks/cache/swebench-runtimes` by source and adapter identity.
Trials record the exact package hashes and Node version. No source checkout,
benchmark solution, host configuration, or Docker socket is mounted into the
candidate. Removing that cache simply requires rebuilding on the next run.

`--timeout <seconds>` overrides the candidate budget. `--skip-grading` captures
the attempt without running the evaluator. Trials retain provenance, the client
result, database/digest, patch, and evaluator output; the runner prints their paths.

To test the evaluator independently of a model, grade the dataset's own patch:

```sh
node swebench/evaluate.ts --instance mwaskom__seaborn-3010 --patch gold --out /path/to/trial
```

## Campaigns

[corpora/](corpora/) holds task selections and their provenance. A seeded sample
is a new selection; the checked-in
[HarnessTax corpus](corpora/harnesstax-swe-lite-30.json) identifies its cited study
and exact task set. Matching tasks alone does not match a study's model,
effort, attempt count, or limits.

To create a separate reproducible sample:

```sh
node swebench/sample.ts --label my-sample --seed my-seed --mode stratified --pin
```

Run a checked-in corpus by its filename stem:

```sh
swebench/campaign.sh --corpus harnesstax-swe-lite-30 --attempts 3 --jobs 1 --preflight
swebench/campaign.sh --corpus harnesstax-swe-lite-30 --attempts 3 --jobs 1
node swebench/report.ts /path/to/campaign
```

Campaigns retain each attempt and write `REPORT.md`. The default stops new work
after a non-pass so it can be inspected. `--halt-on clean` also permits ordinary
oracle misses. Use `--resume <campaign-directory>` after reviewing a pause;
`--skip <id>` records an intentional omission rather than replacing a failed trial.
`--limit`, `--only`, and `--jobs` bound the selected work and concurrency.

Add `--json` to the report command for machine-readable results. Read failure
and missing-telemetry sections alongside the aggregate scores.

## Native Pi comparison

[pi.mjs](pi.mjs) runs the installed Pi CLI against the same specimen, prompt,
test image, and evaluator. Pi retains its own system prompt and tools. The
adapter selects the provider/model/effort, isolates personal context, applies
benchmark limits, and records requests without rewriting them.
Both native Chat Completions and Messages transports retain raw wire evidence.
Reports distinguish complete token accounting from provider-billed cost and
from an optional reasoning-token breakdown.

A profile JSON supplies these fields:

| Fields | Meaning |
|---|---|
| `executable`, `version` | Installed Pi executable and its exact expected version. |
| `provider`, `model`, `effort` | Model selection; supported provider paths are `openrouter`, `deepseek` and `fireworks`. |
| `catalogPath` | Frozen `models-store.json` containing the selected model. |
| `turnCap`, `timeoutSeconds` | Positive run limits. |
| `rates` | `input`, `output`, `cacheRead`, and `cacheWrite`, in USD per million tokens, for reporting. |

Refresh the catalog with
`PI_CODING_AGENT_DIR=<catalog-directory> pi update --models`.
Credentials never go in the profile.

```sh
node swebench/pi.mjs --instance django__django-11620 --profile /path/to/profile.json --preflight
node swebench/pi.mjs --instance django__django-11620 --profile /path/to/profile.json
node swebench/pi-campaign.mjs --corpus swebench/corpora/harnesstax-swe-lite-30.json \
  --profile /path/to/profile.json --out /path/to/campaign --attempts 3 --jobs 1
```

Reusing a Pi campaign directory resumes unattempted pairs with the unchanged
profile. Native Pi failures remain scored attempts and do not pause the sweep;
adapter, setup and evaluator failures do. `agent/summary.json` distinguishes
provider charges, fixed-rate estimates, and missing telemetry.

The optional installed-client check uses a local fixture server:

```sh
PLURNK_BENCH_PI=/absolute/path/to/pi node --test swebench/pi.test.mjs
```
