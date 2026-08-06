# plurnk-bench — Specification

Canonical contracts the bench makes: what a `BenchRecord` asserts, what a published
`benchmarks/run<N>` contains, and what the runner carries into a task container. The bench's
complaints to the constellation are only as credible as these contracts — this file is what a
skeptic audits before trusting a filed issue. `AGENTS.md` covers process; this file covers
contract.

The `§` sigil marks a stable terse tag (house convention, see plurnk-service SPEC.md): a
section is a tag (`§verdicts`); a promise under it is a child tag (`§verdicts-oracle-outranks`)
whose prefix names its section. Tests cite tags in their names (`test("[§<tag>] …")`). A
contract line with no citing test says **uncovered** — visibly, not silently.

---

## §verdicts Two verdicts, never conflated

The record carries two independent judgments and never lets one set the other:

- **`status`** — plurnk's terminal SEND code: how the *agent loop* ended (200 ok, 499
  cancelled, 4xx/5xx failed). The loop's own claim about itself.
- **`outcome` / `reward` / `testPassFraction`** — the *benchmark oracle*'s score (DeepSWE:
  Pier's verifier running the repo's tests against the produced patch). A loop can end 200
  and still fail the oracle; the oracle never inherits the loop's optimism.

### §verdicts-oracle-outranks The oracle is ground truth for PASS

`reward === 1` → `outcome = "pass"`, regardless of how the loop ended — a cancelled (499) or
timed-out loop whose patch passes all tests still passed the benchmark.
Covered: `ingest.test.ts [§verdicts-oracle-outranks]`.

### §verdicts-failure-class Non-pass is classified by the loop's failure mode

In order: client Problem doc -> `error`; `timedOut` -> `timeout`; `finalStatus 499` ->
`cancelled`; oracle never graded (`reward.json` absent) → `error`; else `fail`. Pier-level
exceptions (`AgentTimeoutError`, `VerifierTimeoutError`) reclassify an `error` outcome to
`timeout` — but never overwrite a verdict a real loop doc already landed.
Covered: `ingest.test.ts [§verdicts-failure-class]`, `[§provenance]`.

## §turns-provenance Turn count comes from the doc's own turns[] array

The client doc's `turnCount` reports 0 on abnormal termination even when turns really ran;
the doc's `turns[]` array is honest. Precedence: `turns[].length` → `turnCount` → 0. The
bench never opens the daemon DB to count (see §digest-boundary).
Covered: `ingest.test.ts [§turns-provenance]`.
Known gap: on a bridge/crash run the doc is error-only (no `turns[]` at all) and the record
reports 0 while the digest knows better (e.g. run42: record 0, digest 46). Open work: prefer
the digest's count for error docs.

## §attempt-telemetry Failure-mode telemetry — a 0-reward must be legible

Read from Pier's graded `model.patch`, never inferred from the loop's claims:

- `patchLines` — textual lines in the graded patch, excluding Git's encoded binary payload;
  empty patch → 0.
- §attempt-files-modified `filesModified` — EXISTING files changed (`diff --git` count minus
  `new file mode` count). A junk dump (new .txt files into /app) is non-empty but modifies 0
  existing files → still NO-ATTEMPT.
  Covered: `ingest.test.ts [§attempt-files-modified]`.
- §attempt-broke-build `p2pRegressed` — a base pass-to-pass test now fails: the patch broke
  the build / existing behavior. Set iff `p2p_passed < p2p_total`.
  Covered: `ingest.test.ts [§attempt-broke-build]`.
- §attempt-partial-gated `testPassFraction` is ONLY meaningful when `outcome` says a loop ran
  (pass/fail) — on error/timeout/cancelled it is the base repo's grade, not progress.
  **Uncovered** (documented on the field; no test asserts the gating).

Failure modes these compose to: `filesModified 0` → NO-ATTEMPT · `filesModified>0 +
p2pRegressed` → BROKE-THE-BUILD · `filesModified>0, no regress, fraction<1` → NEAR-MISS.

## §digest-boundary Bench never reads the daemon DB

DB→forensics belongs to the daemon's own digest (reused via
`@plurnk/plurnk-service/digest`), backed by the SqlRite ORM — bench holds a **pointer**
(`RunRef.dbPath`), renders through `Digest.run`, and issues zero raw SQL. The handle rules:
loop doc carried `workspace`+`workerId` -> scoped handle; crash/error doc but a DB was copied ->
`dbPath`-only handle (digest renders the whole DB); no DB copied → no handle, honestly
absent — the bench never fabricates one.
Covered: `ingest.test.ts [§digest-boundary]` ×2, `digest.test.ts [§digest-boundary]` ×2,
`record.test.ts [§digest-boundary]`.

## §platform-package-boundary Public platform dependencies follow their owners

The bench imports runtime-neutral Problems, operation-result validation, and their types
directly from the independently published `@plurnk/plurnk-contracts` package. It imports
daemon-owned digest behavior from `@plurnk/plurnk-service/digest`. Both dependencies resolve
from the public npm registry and the committed lockfile; a sibling checkout, workspace link,
local path, or unpublished package is never part of the bench's install contract.

## §record-serial The record is a store row

`BenchRecord` round-trips through JSON without loss — it serializes 1:1 to `record.json` /
a JSONL line.
Covered: `record.test.ts [§record-serial]`, `[§verdicts]`.

The accepted client-document schema is version 3. Its run reference uses
`workspaceId`/`workerId`/`loopId`; cost is the ordinary numeric `costUsd`
reported by the daemon. A failed client document preserves its exact RFC 9457
Problem under `problem`; Pier exceptions are mapped once to a `bench:pier`
Problem. Version 1, legacy session/run coordinates, pico-USD, the old `error`
field, and flattened failure strings are rejected rather than translated.

## §provenance Job-tree walking and trial identity

A trial dir is any child of `jobs/<job>/` holding a `result.json` with a `trial_name` (the
job-level result.json has none). `result.json` is the provenance source: `task_name`,
`config.agent.model_name`, Pier timing and exceptions. Trials walk in directory-name order —
deterministic output.
Covered: `ingest.test.ts [§provenance]`.

## §publish The published run is the complete, canonical result

`publishRun` writes `<plurnk>/benchmarks/run<N>/` containing **`plurnk.db`** (the copied
daemon DB), **`digest/`** (rendered from the COPY — the dir is self-contained), and
**`record.json`** (the joined landing: the oracle side the DB+digest cannot carry).

- §publish-numbering `run<N>` auto-increments: max existing + 1, else 1; non-run dirs ignored.
  Covered: `publish.test.ts [§publish-numbering]`.
- §publish-turnless-gate A turn-less DB (infra failure — the daemon never looped) is rolled
  back, not published. Gate: the rendered digest's `turns`.
  Covered: `publish.test.ts [§publish-turnless-gate]`.
- §publish-model-attempt-gate Automated setup/orchestration turns before the provider
  completes do not make an infrastructure failure a benchmark attempt. A published run
  requires positive provider token usage; zero or absent usage is skipped before copying
  the DB into the canonical tree.
  Covered: `publish.test.ts [§publish-model-attempt-gate]`.
- §publish-self-referential `record.json`'s digest handle points at the PUBLISHED copy,
  never back into the gitignored `jobs/` scratch; the input record is not mutated.
  Covered: `publish.test.ts [§publish-self-referential]`.
- §publish-requiem Publish banks the requiem (`digest/requiem.md` — the model's exit
  interview, which re-invokes the model) BEST-EFFORT under the carried provider config: a
  missing witness is a skip, never a publish failure.
  **Uncovered** (requiem needs a live provider; validated against real runs only).
- No run handle → nothing to publish (`null`) — the bench never fabricates a run dir.
  Covered: `publish.test.ts [§publish]`.

## §results-canon Where results are read

Published runs under `<plurnk>/benchmarks/run<N>/` (a sibling of the bench repo) are the
canonical results source — landings from `record.json`, forensics through `digest/`.
`jobs/` is gitignored Pier scratch; its ONLY read is the daemon log of a 0-turn boot failure,
which never publishes (§publish-turnless-gate).
Covered: `publish.test.ts [§results-canon]` (tree location).

## §benchlet-diagnostic Pinned host-side diagnostics

`deepswe/benchlet.sh [--task task] [model]` is the sole host-side entrypoint for
iterative diagnosis against a checked-in task manifest. The default task is
`abs-module-cache-flags`. A selected task, candidate model, source revisions,
and personality snapshot remain fixed within a run. The benchlet is not a
leaderboard result and does not replace Pier; its value is repeatability and
complete evidence while changing one experimental variable at a time.

- §benchlet-provenance The manifest pins the upstream repository commit, task
  files and hashes, environment, verifier backend, and verifier timeouts. A run
  requires clean bench, service, and client commits and records those
  revisions. The complete pinned task is copied into the run artifact.
- §benchlet-client-checkout Host-side candidates require an explicit outside
  client checkout: `PLURNK_BENCHLET_CLIENT_ROOT` for DeepSWE and
  `PLURNK_BENCH_ATLAS_CLIENT_ROOT` for Atlas. Portable defaults never guess a
  sibling checkout. Missing or blank input fails before run allocation or
  external activity; relative paths resolve from the bench root, and the exact
  clean client revision remains part of run provenance.
- §benchlet-oracle The harness proves the pristine baseline before invoking a
  model. The ABS diagnostic delegates preparation to the task's
  `grader.py prepare` and runs its selected suites through ordinary
  `go test -json`. Docker-backed diagnostics run the pinned task image and
  canonical `tests/test.sh`, then require consistent `reward.json` and
  `ctrf.json` evidence. Malformed output is infrastructure failure; absent test
  evidence fails rather than passing by omission.
- §benchlet-two-patches `model.patch` is only `base..HEAD`, matching the
  committed submission the canonical benchmark grades. `working.patch`
  separately captures committed, tracked, and untracked working state. Both
  are graded and named distinctly; an uncommitted solution is never reported
  as the submitted score.
- §benchlet-evidence Every command records raw stdout, raw stderr, exit status,
  signal, and timeout state before the harness reads its output. A complete run
  includes the database, digest, exact packet files, all provider attempts and
  their reasoning/admission errors, terminal loop Problems, both oracle
  results, exact requiem request and response evidence, usage, and USD cost.
- §benchlet-failure A run with no provider attempt is infrastructure, not a
  model score. A requiem is complete only when its process succeeds and both
  `requiem.md` and `requiem.json` exist. Infrastructure failures retain the
  stage, error, provenance, and all artifacts written before the failure.
- §benchlet-requiem-witness The requiem is an independent forensic model call,
  not another candidate turn. `PLURNK_BENCHLET_REQUIEM_MODEL` names its
  required witness alias; the candidate alias is never an implicit fallback.
  Provenance records both aliases, and the witness receives the complete
  evidence without truncation or summarization.
- §benchlet-location Runs are atomically allocated as sibling
  `../benchmarks/run<N>-deepswe-<task>-<model>/` directories. Concurrent claims
  advance to another number rather than nesting or reusing a run.

Covered: `benchlet.test.ts [§benchlet-oracle]`,
`[§benchlet-evidence]`, `[§benchlet-failure]`, `[§benchlet-location]`,
`[§benchlet-requiem-witness]`, and
`client-checkout.test.ts [§benchlet-client-checkout]`. The real `--preflight`
path covers task hashes, repository fetch, official verifier preparation, and
the pristine baseline.

## §config-carry The runner carries authoritative config, re-declaring nothing

`deepswe/smoke.sh` reads the daemon's config from its authoritative sources IN PLACE —
model layer from `~/.plurnk/.env`, provider env from the shell — and forwards every set
`PLURNK_*` / `*_BASE_URL` / `*_API_KEY` to the in-container daemon via `--agent-env`. The one
container-boundary transform: loopback (`127.0.0.1`/`localhost`) in a `*_BASE_URL` rewrites
to the host LAN IP. Child contracts:

- §config-bench-namespace Bench-invented knobs are namespaced `PLURNK_BENCH_*`
  (TIMEOUT_SEC, CPUS, FORCE_BUILD, NO_GBNF) and are orchestration, never daemon config —
  excluded from forwarding.
- §config-gbnf-optout `PLURNK_BENCH_NO_GBNF=1` forwards `PLURNK_PROVIDERS_GBNF=0` — an
  explicit override, because the container's shipped .env floor defaults GBNF ON and mere
  omission cannot turn it off.
- §config-budget The client timeout tracks the BENCHMARK's own budget: the task's
  `[agent] timeout_sec` minus headroom — never an arbitrary cap that would starve the model
  and understate results.
- §config-native-cpus The container runs the task's native cpu allotment
  (leaderboard-compliant; `--override-cpus` disqualifies). `PLURNK_BENCH_CPUS` is the
  explicit opt-in override.
- §config-client-surface The harness does not invent a transport target. Its
  in-container daemon and `plurnk` client use the product's AG-UI+ HTTP/SSE
  defaults; an explicit `PLURNK_HOST`, `PLURNK_PORT`, or `PLURNK_AGUI_URL`
  remains ordinary daemon/client configuration.
- §config-package-version Resolve exact current service/client npm versions and pass them
  as driver kwargs. A publication changes Pier's image-build fingerprint; registry failure
  aborts rather than reusing an unidentified cached image.
  Covered: `smoke.test.ts [§config-package-version]`.
- §config-browser-disabled DeepSWE's constrained task image provides no Playwright browser
  runtime, so the runner explicitly selects the published service's supported `disabled` mode.
  HTTP byte fetch remains available; only the optional browser fallback is unavailable.
  Covered: `smoke.test.ts [§config-browser-disabled]`.

## §snapshot-wal The daemon DB artifact includes committed WAL state

The driver snapshots the live daemon database with SQLite `VACUUM INTO`. It never falls
back to copying the main file without its WAL and fails the trial if a consolidated
snapshot cannot be produced.
Covered: `test_driver.py [§snapshot-wal]`.
