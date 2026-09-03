# plurnk-bench — Specification


> **Family status (2026-08-31, #17):** `deepswe` is the active family (local-model target); `terminal_bench`, `atlas`, and `enterprise` are retired-revivable — their sections remain normative for their code, which stays in-tree, but no active surface invokes them.
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
  the build / existing behavior. `true` iff `p2p_passed < p2p_total`, `false` when the counted
  suite fully passes, absent only when the reward carries no p2p counts — "not regressed" and
  "not measured" never share a spelling.
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

The accepted client-document schema is version 6. Its run reference uses
`workspaceId`/`workerId`/`loopId`, and its complete `usage` envelope is preserved
verbatim: ordered physical requests are the accounting evidence, known aggregate
token quantities remain optional, and `costUsd` is an exact decimal string or
`null`. Curation `curationWeight`/`curationBudget`, physical context
`contextTokens`/`contextCapacity`, and provider metadata remain sibling fields;
bench never compares model-independent weight with provider tokens and does not
project rates, tokens, or cost.
A failed client document preserves its exact RFC 9457
Problem under `problem`; Pier exceptions are mapped once to a `bench:pier`
Problem. Earlier client schemas, legacy session/run coordinates, pico-USD, the
old `error` field, and flattened failure strings are rejected rather than translated.

§accounting-cache-effectiveness Benchlet summaries derive one diagnostic cache
metric from the daemon's authoritative aggregate usage. When both total input
tokens and cache-read tokens are known, `cacheEffectiveness` preserves those
counts, any known cache-write count, and reports
`cacheReadTokenRatio = cacheReadTokens / inputTokens`. Zero input has a `null`
ratio; missing quantities make the complete projection `null`. The ratio is
token-weighted, not a request hit rate, and never substitutes for the retained
accounting evidence.

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

- §publish-numbering `run<N>-<harness>-<task>-<model>`: N continues the tree (max existing + 1,
  else 1; non-run dirs ignored), the task is its last path segment, the model its alias — the
  same shape the benchlets allocate.
- §publish-turnless-gate A turn-less DB (infra failure — the daemon never looped) is rolled
  back, not published. Gate: the rendered digest's `turns`.
  Covered: `publish.test.ts [§publish-turnless-gate]`.
- §publish-model-attempt-gate The DB's own evidence decides: a published run holds at least
  one model turn in its digest. Setup/maintenance turns alone are no attempt; a trial whose
  client record died mid-loop (a bridge error stub) still publishes, because its model turns
  are in the DB.
- §publish-live Each trial publishes the moment it finishes: the runner starts its harness in
  the background and `publish.ts --watch <job> --pid <harness>` follows the job, publishing
  every finished trial (record + digest) and sweeping once more when the harness exits — a
  corpus can be followed run by run while it is still going. A trial publishes exactly once:
  its `.plurnk-bench-published` marker names the run dir (empty when nothing was publishable).
- §publish-self-referential `record.json`'s digest handle points at the PUBLISHED copy,
  never back into the gitignored `jobs/` scratch; the input record is not mutated.
  Covered: `publish.test.ts [§publish-self-referential]`.
- §publish-requiem The requiem (`digest/requiem.md` — the model's exit interview, which
  re-invokes the model once per published run) is an investigation instrument, banked only
  when the operator asks: `PLURNK_BENCH_REQUIEM=1` (SPEC §config-bench-namespace). When
  requested it is BEST-EFFORT under the carried provider config: a missing witness is a
  skip, never a publish failure. Covered: `src/publish.test.ts [§publish-requiem]` (the
  opt-in gate); the live requiem itself is validated against real runs only.
- §publish-workspace-scope The published digest is workspace-scoped, never worker-narrowed:
  the trial container's DB holds one fresh workspace, and the workerId selector would
  exclude workspace-owned (turnless) embedding derivations — the vector pump's entire
  ledger — plus any child worker's own evidence. record.json keeps `run.workerId` as a
  drill-down handle only. Covered: `src/publish.test.ts [§publish-workspace-scope]`.
- §publish-requiem-accounting A banked interview's spend is part of the run's ledger:
  after the requiem lands, its accounting summary (workers, provider requests, usage,
  cache effectiveness, exact nullable USD) folds into `record.json` under `requiem`, so
  a corpus tally reads one file per run. A fold failure after a banked interview is a
  defect and fails hard — never a silent skip. Skipped interviews fold nothing.
  Covered: `src/publish.test.ts [§publish-requiem-accounting]`.
- No run handle → nothing to publish (`null`) — the bench never fabricates a run dir.
  Covered: `publish.test.ts [§publish]`.

## §results-canon Where results are read

ONE tree — the benchmarks home, `~/benchmarks` unless `PLURNK_BENCH_HOME` says otherwise —
holds everything a run produces: published runs at its root
(`run<N>-<harness>-<task>-<model>/`, landings from `record.json`, forensics through
`digest/`), and each harness's job scratch under `jobs/<harness>/` (Pier's and Harbor's own
trees, needed by their verifiers and resume). Nothing lands inside a repository or anywhere
else. Published runs are the canonical results source; `jobs/` is scratch whose ONLY read is
the daemon log of a 0-turn boot failure, which never publishes (§publish-turnless-gate).
Covered: `host-paths.test.ts`, `publish.test.ts [§results-canon]`.

## §benchlet-diagnostic Pinned host-side diagnostics

`deepswe/benchlet.sh [--task task] [model]` is the sole host-side entrypoint for
iterative diagnosis against a checked-in task manifest. The default task is
`abs-module-cache-flags`. A selected task, candidate model, source revisions,
and policy snapshot remain fixed within a run. The benchlet is not a
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
  includes the database, digest, exact packet files, every physical provider
  request plus logical emissions and their reasoning/admission errors, terminal
  loop Problems, both oracle results, exact requiem request and response evidence,
  usage, nullable daemon-reported USD cost, and the ordered
  charged/estimated/unknown evidence from which the daemon derived it. Result
  documents use schema version 2;
  `providerRequests` is physical cardinality, `rejectedEmissions` is admission
  evidence, native provider usage is preserved, and USD totals remain exact
  decimal strings or `null`. Failure summaries count causal incidents rather
  than log projections: a failed operation is one incident, and terminal
  channel observations sharing one worker-owned stream address are one stream
  incident whose channels remain listed as evidence. The summary reports both
  incident counts by Problem type and the number of underlying observation rows.
- §benchlet-failure A run with no physical provider request is infrastructure, not a
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
- §benchlet-candidate-timeout `PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC` accepts
  the positive cap, or `-1` — the plurnk no-limit idiom — which removes the
  candidate timer entirely; the overhead still applies to the run's records.

Covered: `benchlet.test.ts [§benchlet-oracle]`,
`[§benchlet-evidence]`, `[§benchlet-failure]`, `[§benchlet-location]`,
`[§benchlet-requiem-witness]`, `[§benchlet-candidate-timeout]`, and
`client-checkout.test.ts [§benchlet-client-checkout]`. The real `--preflight`
path covers task hashes, repository fetch, official verifier preparation, and
the pristine baseline.

## §config-carry The runner carries authoritative config, re-declaring nothing

`deepswe/smoke.sh` reads the daemon's config from its authoritative sources IN PLACE —
model selection from the shell/XDG/committed-default cascade, alias tuning from
`${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env`, and provider env from the shell — and forwards every set
`PLURNK_*` / `*_BASE_URL` / `*_API_KEY` to the in-container daemon via `--agent-env`. The one
container-boundary transform: loopback (`127.0.0.1`/`localhost`) in a `*_BASE_URL` rewrites
to the host LAN IP. Child contracts:

- §config-model-default The candidate model uses the product's ordinary
  `PLURNK_MODEL` cascade: an invoking-shell value, then the XDG operator file,
  then the committed benchmark default. Harnesses admit no positional or
  benchmark-specific candidate selector. Distinct actors such as a requiem
  witness, judge, or child retain their named selector and deliberately inherit
  the resolved candidate when their contract permits an unset value. Covered:
  `host-paths.test.ts`, `smoke.test.ts`, and `[§config-model-default]` in
  `benchlet.test.ts`.
- §config-embedding-route Every mode forwards ONE public OpenAI-compatible embedding route
  (`PLURNK_BENCH_EMBEDDING_ROUTE` on `PLURNK_BENCH_EMBEDDING_BASE_URL`, a built-in daemon
  profile needing no facts) and allowlists its host; the operator's own `PLURNK_EMBEDDING_*`
  never rides. The container cannot reach a loopback embedder, and the corpus must not embed
  on the task's CPU allotment. Covered: `[§config-embedding-route]` in `smoke.test.ts`.
- §config-image-prepull Every task image is pulled outside the run — `deepswe/prepull.sh
  [task-glob|all]`: bounded parallelism (default 3), retries with backoff, a docker-volume
  disk floor (default 40 GB), a loud list of anything unresolvable — and the launcher runs it
  before `pier run`, so an N-wide launch never stampedes the registry and no trial dies at
  environment setup or spends its build timeout downloading (2026-08-30: ~50 of 113 trials
  failed to resolve their ECR image at 38-wide). Covered: `[§config-image-prepull]` in
  `smoke.test.ts`.
- §config-digest-preflight The bench's installed `@plurnk/plurnk-service` must equal the
  version the corpus installs: its digest reads the databases the in-container daemons write.
  A mismatch refuses the launch (2026-08-30: a 1.11.0 digest crashed on 1.12.0 databases mid-run).
- §config-publisher-decoupled The live publisher runs beside pier, never over it: its failure
  is logged, pier is waited on regardless, one idempotent final `publish.ts <job>` pass
  publishes every trial the live watch missed, and a trap ends pier, publisher, and sampler
  with the launcher — nothing runs orphaned.
- §config-failed-setup-report Trials that never reached a model turn because their environment
  failed to start are listed in `<job>/failed-setup.txt` (task ids, a rerun list) and counted
  on stderr at the end of the run.
- §config-resource-samples Every run records `docker stats` for all containers once a minute,
  for pier's lifetime, as JSON lines in `<job>/docker-stats.jsonl` (`t` = UTC sample time). The
  record is the basis for sizing corpus concurrency (per-container CPU and memory under real
  load) — never an estimate. Covered: `[§config-resource-samples]` in `smoke.test.ts`.
- §config-bench-namespace Bench-invented knobs are namespaced `PLURNK_BENCH_*` (`PLURNK_BENCH_HOME`,
  `PLURNK_BENCH_HARNESS`, `PLURNK_BENCH_REQUIEM`, …)
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
- §config-tavily-route Tavily follows ordinary optional-provider carriage: a configured
  `TAVILY_API_KEY` is forwarded, while no key remains the default. Pier and host-run
  artifacts record only configured/absent and the effective `basic`/`advanced` depth.
  Covered: `smoke.test.ts [§config-tavily-route]`, `test_driver.py`,
  `web-materialization.test.ts`, and `ingest.test.ts`.

## §snapshot-wal The daemon DB artifact includes committed WAL state

The driver snapshots the live daemon database with SQLite `VACUUM INTO`. It never falls
back to copying the main file without its WAL and fails the trial if a consolidated
snapshot cannot be produced.
Covered: `test_driver.py [§snapshot-wal]`.

## §enterprise Enterprise-Bench L1-L2 is a first-class family beside DeepSWE and Atlas

DevRev Enterprise-Bench measures cross-system retrieval and joins over three MCP services
(Jira-style PM, Salesforce-style CRM, Drive-style file server), judged by the benchmark's
own LLM judge against per-task criteria. The family drives each task through the ordinary
plurnk client/service boundary under Harbor, the benchmark's execution harness; the bench
never reproduces an agent loop.

- §enterprise-provenance The runner pins `devrev/enterprise-bench` at one commit, checks it
  out detached, refuses a modified checkout, and builds the benchmark's own base image and
  MCP services from the pinned artifacts. TrueForge's published comparison kit
  (`truefoundry/trueforge@b11cfc3b`) is a reproducibility reference only — never a
  dependency, never an alternate corpus. Covered: `enterprise/smoke.test.ts [§enterprise-provenance]`.
- §enterprise-profiles `single` (1 trial per task) is the diagnostic default; `comparison`
  (3) reproduces the shape of TrueForge's published 14-task comparison; `canonical` (10)
  follows Enterprise-Bench's reliability methodology (140 observations). Reporting never
  conflates the three. Covered: `enterprise/smoke.test.ts [§enterprise-profiles]`.
- §enterprise-mcp-carry Harbor hands the benchmark's `mcp.json` to the driver, which
  declares each service as a plurnk HTTP MCP server (`PLURNK_MCP_<ALIAS>=<url>`), enables
  and expands exactly those, and derives the alias from the benchmark's server name by
  keeping its letters and digits (`file-server` → `fileserver`). `host.docker.internal` is
  rewritten to the host LAN IP for Linux Docker; the exact carriage is recorded as
  `agent/plurnk-mcp.json`. The operator's own MCP fleet never rides. Covered:
  `test_driver.py`, `enterprise/smoke.test.ts [§enterprise-mcp-carry]`.
- §enterprise-posture The candidate runs with the task container's `/workspace` as its
  project root (scratch files, payloads, and helper scripts land there; no repository, so
  branch-tagged workers are refused), web-free and non-interactive, with executors limited
  to the shell and the benchmark's MCP aliases.
  The shell is the task's own submission path: every instruction tells the agent to POST
  its answer to the container's `/submit_agent_response`. Vector embedding is capped at
  256 KB per channel (`PLURNK_SERVICE_MAX_EMBED_SIZE`, recorded in provenance): the
  daemon's unlimited default let one unfiltered 8.4 MB SOQL result stall a loop for seven
  minutes of synchronous embedding on the task's two CPUs; the cap rejects vectors only,
  leaving FTS, READ, and the graph exhaustive over such dumps. Covered: `test_driver.py`.
- §enterprise-answer The harness never submits on the model's behalf. An unsubmitted or
  duplicated answer is the model's failure and the benchmark's judge records it as such;
  the submitted answer, when present, is kept beside the record as `agent/responses.jsonl`.
  Covered: `test_driver.py`.
- §enterprise-oracle The oracle is Harbor's `verifier/reward.txt` (binary at one), joined
  like DeepSWE's `reward.json`; `judge_result.json` stays in the trial for forensics. The
  judge key comes from the invoking shell (Harbor interpolates the task's `[verifier.env]`);
  its absence refuses the run before any spend rather than scoring an agent failure.
  Covered: `src/ingest.test.ts [§enterprise-oracle]`, `enterprise/smoke.test.ts [§enterprise-oracle]`.
- §enterprise-budget-groups Tasks declare their own `[agent] timeout_sec` (600 s for twelve,
  900 s for `sales-l2-a` and `sales-l2-d`). Harbor runs one path under one agent configuration,
  so the corpus is grouped by budget into dataset views (`.cache/enterprise-groups/<budget>/`,
  copies of the pinned task directories) and each group runs as its own job with that budget
  minus headroom; every job is published. Covered: `enterprise/smoke.test.ts [§enterprise-budget-groups]`.
- §enterprise-specimen `enterprise/specimen.sh <task> [model]` runs ONE task against a daemon
  built from a checkout (the service repo's `scripts/candidate.mjs`, client from
  `PLURNK_CLIENT_CHECKOUT`) — unreleased engine and teaching — while the benchmark keeps its
  truth: the pinned task container hosts the submission endpoint and runs the official judge
  over the pinned tests. The daemon runs on the host, so the model's shell runs on the host;
  the run dir (`run<N>-enterprise-specimen-<task>-<model>`) records service/client/corpus
  provenance, the client record, the digest, the submitted answer, and the verifier output.
  It is the iteration instrument; `enterprise/smoke.sh` remains the isolated, publishable one.
  Covered: `enterprise/specimen.test.ts [§enterprise-specimen]`.
- §enterprise-spend The live route and the judge are explicit spending decisions: the
  candidate is the run's alias (`deepdumb` first — the whole corpus must complete before
  any same-model comparison against TrueForge's GLM-5.2 figure on the `glm` alias), and
  usage is the daemon's exact accounting; estimates stay classified as estimates.

## §frontier-parity FrontierHarness Eval v1 is a parity lane, not a corpus

`terminal_bench/frontier.manifest.json` names the frozen selection of [FrontierHarness Eval v1](https://github.com/runta-dev/frontier-harness-eval): 21 Terminal-Bench 2.1 tasks (Harbor dataset `terminal-bench/terminal-bench-2-1`) and 9 DeepSWE v1.1 tasks, each once, with the published model route. `terminal_bench/frontier.sh` runs them through the existing Harbor agent (`terminal_bench/plurnk_agent.py`), one Harbor job per task, so every client timeout is that task's own `[agent] timeout_sec` minus the boot-and-snapshot headroom (`deepswe/smoke.sh`'s 120 s); a Harbor job carries one agent-kwarg set and the budgets differ per task. The plan is read from the task dirs before any launch (`--preflight` stops there), a run directory records manifest, plan, and provenance, and the summary reads Harbor's `verifier/reward.txt` per job: pass, fail, or missing — a task without a trial is never a fail. The DeepSWE nine run through Harbor here for one mechanism per comparison; Pier remains the DeepSWE publication path ({§benchlet-diagnostic}, {§results-canon}), and a frontier run is a diagnostic beside published harness results, never a corpus record. Corpus state stays downloaded under `.cache/`, never committed.
