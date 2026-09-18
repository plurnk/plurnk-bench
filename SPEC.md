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

## §deepswe-report DeepSWE campaign reporting

`deepswe/report.ts <job-directory>` joins finished Pier trial
records to their published workspace digests. Binary oracle rewards determine
pass rate; ungraded trials remain separate. Cost, cache, and duration medians are
task-weighted and state their reported/eligible coverage. Unknown accounting is
not zero. Request cost provenance distinguishes charged, estimated, and unknown
amounts. Duration is the client's agent-loop wall time. The runner's saved counts
are a timestamped snapshot, not a process-liveness assertion. Repeated attempts
for one task require explicit selection rather than best-result picking.

§deepswe-comparison Optional `--baseline <trials.json> --profile <config>`
matches graded candidate tasks to the exact selected upstream configuration.
All upstream trials marked `included_in_score` contribute their binary
`score_value`; never select each task's best attempt. Missing counterpart tasks
remain explicit and are excluded from both matched denominators. Peer token and
agent-time medians use that same matched set. Historical USD figures are not
silently compared under different rate cards.

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
`workspaceId`/`workerId`/`loopId`, and ingest preserves its complete `usage` envelope.
Publication applies {§publish-task-accounting}: ordered physical requests are the accounting evidence, known aggregate
token quantities remain optional, and `costUsd` is an exact decimal string or
`null`. Curation `curationWeight`/`curationBudget`, physical context
`contextTokens`/`contextCapacity`, and provider metadata remain sibling fields;
bench never compares model-independent weight with provider tokens and does not
project rates, tokens, or cost.
A failed client document preserves its exact RFC 9457
Problem under `problem`; Pier exceptions are mapped once to a `bench:pier`
Problem. Earlier client schemas, legacy session/run coordinates, pico-USD, the
old `error` field, and flattened failure strings are rejected rather than translated.

§accounting-cache-effectiveness `cacheEffectiveness` measures model prompt caching
from the daemon's physical request ledger: every `emission` and `bare` request,
across workers, retries and rejected emissions. Requiem interviews
use their own model-request ledger. Each included request must report input and
cache-read tokens; otherwise the projection is `null`, not a selected complete
subset. With complete evidence, sum those counts and report
`cacheReadTokenRatio = cacheReadTokens / inputTokens`; include cache-write tokens
only when every included request reports them. No model requests yields `null`;
explicit zero input yields counts with a `null` ratio. Invalid per-request counts
fail before aggregation. The ratio is token-weighted, not a request hit rate,
and never substitutes for the retained accounting evidence.

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
  exclude child worker evidence. record.json keeps `run.workerId` as a
  drill-down handle only. Covered: `src/publish.test.ts [§publish-workspace-scope]`.
- §publish-task-accounting Published `record.json` uses the digest's sole workspace
  `accounting` projection verbatim under `usage.accounting`, including child, BARE,
  and failed physical requests. An unsettled projection remains `null`, never a
  parent-only total or zero. Primary-loop context fields retain client values, or
  `null` when absent. Ambiguous workspace scope and inconsistent request cardinality
  fail publication. Client and provider source artifacts remain unchanged.
  Covered: `src/publish.test.ts [§publish-task-accounting]`.
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

`deepswe/benchlet.sh --task <task>` is the sole host-side entrypoint for
iterative diagnosis against a checked-in task manifest; there is no default
task. The release gate runs the two FrontierHarness specimens chosen for being
awkward for Plurnk rather than generically hard (#22): `sqlite-db-truncate`
(a binary the model must read) and `fastapi-deprecation-response-headers`
(2,915 tracked files to admit and embed). A selected task, candidate model,
source revisions, and policy snapshot remain fixed within a run. The benchlet is not a
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
- §benchlet-oracle-exclusion A pass-to-pass test that fails on the pristine
  baseline in this environment cannot discriminate a candidate here, so it
  leaves the graded set for that run only: the pinned task files stay
  byte-identical, the verifier receives the pinned config merged with the
  reduced `p2p_node_ids` (kept beside the grading artifacts as `config.json`),
  and the run records every excluded id with its baseline output in
  `oracle-exclusions.json` and under `oracle.environmentExcludedP2p` in
  `result.json`. Fail-to-pass tests are never excused: a baseline where any
  passes is a broken task. One exclusion is a flaky test; more than one must
  stay within a tenth of the p2p set, otherwise the environment is broken and
  the run stays an infrastructure failure. `--preflight` names what a run would
  exclude. Origin: eicrud's own login rate limiter answered 425 to a test
  expecting 401 because this host ran two attempts inside the framework's
  minimum interval — three runs, the same test, no model involved.
- §benchlet-container-exec The candidate's commands run inside the task image. For a
  Docker manifest the run starts one long-lived container of the pinned image with
  the manifest's network, CPU, and memory limits, the candidate repository
  bind-mounted at its own host path and at `/app`, working directory that path,
  and writes a shim directory in front of the candidate daemon's PATH for every
  executor name the daemon spawns (`sh`, `bash`, `node`, `python3`, `npm`, `cargo`,
  `go`, …). A shim whose working directory lies inside the repository forwards the
  command into the container at the same path, as the host user with the image's own
  `HOME`, stdin and exit status intact; any other working directory runs the real binary
  through the saved host PATH, so the client build and the daemon's own tooling stay
  host-side. Each shim carries the container id, repository path, user, and host PATH
  as literals, because the daemon scrubs its own variables from subprocess
  environments; only PATH reaches the command. At start, the image's own home (its default
  user's `$HOME`, never empty or `/`) is handed to the host user with `chown -R`, because the
  images install toolchains and dependency caches there (`/root/.cargo`, `/root/go/pkg/mod`)
  and the verifier, running as the image's user, sees them. The container is removed when the candidate finishes or the run fails:
  `CandidateContainer` (`deepswe/candidate-container.ts`) owns the lifecycle behind an injected
  runner, so the exact docker invocations, the single removal on stop, the idempotent stop, and
  a failed start that removes what it created are unit witnesses without a daemon or an image.
  `candidate-execution.json` records the image, network, container, home, mounts, and shim
  set (`kind: "task-container"`; host manifests record `kind: "host"`). Origin: on
  2026-09-08 the host lacked the images' optional test dependencies, toolchain
  versions, and services; candidates met phantom test-collection errors and
  repaired the machine instead of the task. On 2026-09-17 the shims ran with `HOME=/tmp`:
  wasmi's `cargo` was "Permission denied" (the image's only toolchain is in mode-700 `/root`) and
  participle's Go module cache was empty under network none, so neither candidate could run the
  task's tests while the verifier could.
- §benchlet-isolation A benchlet candidate reaches no network beyond its model.
  The operator's MCP server and A2A agent definitions (the operator file's and the
  shell's) are set empty in the candidate's environment, which outranks the
  operator file and masks each definition through the configuration cascade;
  controls such as `PLURNK_MCP_ENABLED` and companions are untouched.
  `PLURNK_SCHEMES_HTTP_HOSTS=[]` makes the daemon's own web schemes admit no host,
  and search credentials (`BRAVE_API_KEY`, `TAVILY_API_KEY`) are blanked.
  `candidate-isolation.json` records the masked names. Origin: on 2026-09-17 four
  of ten deepdumb candidates read the upstream solution from GitHub through the
  daemon's `https` scheme, and two queried Brave.
- §benchlet-tree A Terminal-Bench 2.1 task is a tree manifest (`kind:
  "terminal-bench"`, pinned by `pin-task.mjs --terminal-bench`): no repository,
  the image's `/app` copied out as the candidate tree, the task's own `[agent]
  timeout_sec` as the candidate budget, and the harness member definition
  (`PLURNK_MEMBERS_TASK=**`) admitting the candidate tree relative to the
  host-side workspace root. Its state is the sorted sha256 listing of every file, submission and
  working state being one; grading copies the tree over a fresh task
  container's `/app` and runs the canonical `tests/test.sh`, whose
  `reward.txt` and `ctrf.json` must agree. The pristine image must grade 0
  before a model is invoked. The instruction names the container path `/app`;
  the host candidate reads it with that path rewritten to its own tree and the
  rewrite recorded in provenance, since the tree lives in the run directory on
  the host and at `/app` only inside the verifier's container.
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
  Every asynchronous child shares the benchlet's cancellation signal; an operator
  interruption terminates the child and drains both streams before evidence is finalized,
  while a harness watchdog remains distinctly recorded as `timedOut`.
- §benchlet-failure A run with no physical provider request is infrastructure, not a
  model score. A requiem is complete only when its process succeeds and both
  `requiem.md` and `requiem.json` exist. Infrastructure failures retain the
  stage, error, provenance, and all artifacts written before the failure. An
  interrupted allocated run is such a terminal infrastructure failure, never a
  permanently `running` run.
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

Covered: `benchlet.test.ts [§benchlet-oracle]`, `[§benchlet-oracle-exclusion]`, `[§benchlet-container-exec]`
(shims; lifecycle in `candidate-container.test.ts`),
`[§benchlet-evidence]`, `[§benchlet-failure]`, `[§benchlet-location]`,
`[§benchlet-requiem-witness]`, `[§benchlet-candidate-timeout]`, and
`client-checkout.test.ts [§benchlet-client-checkout]`. The real `--preflight`
path covers task hashes, repository fetch, official verifier preparation, and
the pristine baseline.

## §pair-sheet One specimen through both harnesses, one fact sheet

`deepswe/pair.sh --task <task>` runs a pinned DeepSWE task once through the
plurnk benchlet ({§benchlet-diagnostic}) and once through Pier's
`mini-swe-agent` on the same model route, one side after the other, and writes
`PAIR.md` from the two harnesses' own `result.json` files. It is the forensic
comparative reader for one specimen: the plurnk side keeps the benchlet's
digest, the mini side gets `<trial>/digest/steps.md` ({§pair-mini-digest}),
and the sheet puts both oracle verdicts and both cost shapes side by side.

- §pair-route The plurnk side runs the alias (`--alias`, default `PLURNK_MODEL`)
  through the daemon's own route registry. The mini side runs the explicit
  equivalent from `deepswe/pair.aliases.json`: Pier's `-m` model, the
  OpenAI-compatible endpoint, the name of the host variable holding its key,
  and the reasoning effort. Nothing is derived from the plurnk alias; an alias
  without a mini route is refused by name. The key reaches Pier through the
  spawned environment only; `pair.json` records the variable's name.
- §pair-location A pair lives at `<benchmarks>/jobs/pairs/<task>-<alias>-<stamp>/`
  ({§results-canon}): `plurnk/` is the benchlet's runs root for exactly one run,
  `mini/` is Pier's job directory for exactly one trial, `pair.json` is the
  launch record, `facts.json` and `PAIR.md` are the reading. A second run on
  either side is an error, never a merge.
- §pair-facts Both sides read into one fact shape: state (complete, failed,
  skipped, absent), the model the harness reports, the submission grade
  (reward, f2p, p2p, partial), steps, provider requests, tokens (input, cached,
  output), the candidate model's own cost (plurnk's requiem excluded), the
  agent's own wall time beside the harness's, and how the loop ended. A fact
  the harness did not supply is written `absent`, never zero; a side that did
  not finish is `failed` with the harness's own reason and no grade. The sheet
  states facts and names no winner; a pair is one specimen, never a corpus.
- §pair-budget The task's `[agent] timeout_sec` governs the mini side (Pier);
  the plurnk side runs on `PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC`
  ({§benchlet-candidate-timeout}), the operator's parity setting. Both appear
  on the sheet. The benchlet records the candidate stage's own start, end and
  duration in `result.json` so agent wall time is read, not inferred.
- §pair-preflight `--preflight` resolves the route, confirms the task cache
  entry, the key variable and `pier` on PATH, runs the benchlet's own
  preflight, and prints the mini command it would run. `--skip-plurnk` and
  `--skip-mini` run one side; `--sheet <pair>` rewrites `PAIR.md` and
  `facts.json` from what a pair directory holds.

### §pair-mini-digest The mini trajectory read as steps

`deepswe/mini-trajectory.ts` reads a trial's
`agent/mini-swe-agent.trajectory.json` (OpenAI Responses objects interleaved
with `function_call_output` observations) into one record per response: the
assistant's words, the provider's reasoning summary when one was returned, the
bash command it called, the observation's return code, line count and head,
and that response's usage; totals across responses; the exit status and
submission. It is rendered as `steps.md` (one section per step, in the plurnk
digest's register) and `steps.json` under `<trial>/digest/`. A response without
a call has no observation; missing usage is null, never zero.

Covered: `pair.test.ts [§pair-sheet]`, `mini-trajectory.test.ts [§pair-mini-digest]`.

## §bench-confounds The known confounds, each with its fix or its status

Every one of these was found by reading a run after the fact. They are listed
so the next reader checks them first instead of rediscovering them.

| Confound | Status |
|---|---|
| Host toolchain versus task image: the candidate's commands ran on the host while the oracle graded inside the image (2026-09-08). | Fixed. `{§benchlet-container-exec}`: commands run inside the pinned task image through PATH shims into one long-lived container; `candidate-execution.json` records it. |
| Oracle exclusions: p2p tests that fail on the pristine baseline. | Recorded. `{§benchlet-oracle-exclusion}` excludes them from the grade and lists them in `result.json.oracle.environmentExcludedP2p`. |
| Reasoning level, service tier, and sampling per alias: two runs on "the same model" at different effort or temperature. | Recorded. `provenance.aliasConfiguration` keeps the alias's route knobs as the daemon reads them (`PLURNK_MODEL_<alias>`, `_REASONING_`, `_SERVICE_TIER_`, `_TEMPERATURE_`, `_REPEAT_PENALTY_`, capacity knobs; never a credential); the served model id is on every digest model call; a pair's mini effort is in `pair.json`. Matching the two sides is the alias map's job (`{§pair-route}`), not inferred. |
| Mini's provider: upstream DeepSWE rows ran a model name through a different provider than ours. | Fixed by construction inside a pair (both sides on the endpoint the alias map names). A comparison against the upstream `trials.json` remains provider-confounded and is read as such. |
| Budget: the plurnk candidate timeout versus Pier's task timeout. | Recorded on the pair sheet (`{§pair-budget}`); `.env.defaults` sets the candidate timeout to the task budget minus boot headroom. |
| Language version: which service and client revision the candidate ran. | Recorded in `provenance.sources` from clean commits; the lanes are relocked as one command (`{§bench-relock}`). Nothing before the fences language (plurnk-service `d88b3543`) is comparable with anything after it; those run directories are gone and the ledger (#37) starts after it. |
| Image drift: a task image tag resolving to different bytes on different days. | Recorded. The manifest pins the image and provenance keeps the resolved `imageId`. |
| Wall clock: two candidates sharing one host's docker daemon and CPU. | A pair runs its sides one after the other (`{§pair-sheet}`); lanes that must run in parallel are #9's concern. |

## §bench-relock Frozen lanes move with one command

`deepswe/relock.sh <service-ref> <client-ref>` points the two detached
worktrees beside the checkout (`../bench-lanes/plurnk-service`,
`../bench-lanes/plurnk`) at exact commits, creating them on first use and
moving them afterwards, runs `npm ci` in each, and prints the two exports a
lane needs (`PLURNK_BENCHLET_SERVICE_ROOT`, `PLURNK_BENCHLET_CLIENT_ROOT`).
The candidate always runs from a lane, never from a checkout being edited
(`{§benchlet-provenance}`); after a publication the lanes are relocked to the
published commits before any comparative run.

## §config-carry The runner carries authoritative config, re-declaring nothing

`deepswe/smoke.sh` reads the daemon's config from its authoritative sources IN PLACE —
model selection from the shell/XDG/committed-default cascade, alias tuning from
`${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env`, and provider env from the shell — and forwards every set
`PLURNK_*` / `*_BASE_URL` / `*_API_KEY` to the in-container daemon via `--agent-env`. The one
container-boundary transform: loopback (`127.0.0.1`/`localhost`) in a `*_BASE_URL` rewrites
to the host LAN IP. Child contracts:

- §config-unattended Unattended runs default to
  `PLURNK_EXECS_QUESTION=0` from `.env.defaults`. The ordinary executor switch
  removes the question tool and its teaching, including `question.md`.
  Host benchlets inherit the setting;
  DeepSWE forwards it even in the official minimal manifest; Terminal-Bench carries
  it alongside the model manifest. Explicit operator values retain normal precedence.
  Enterprise's executor allowlist already excludes question; its independent
  web restriction remains a capability policy.
- §config-model-default The candidate model uses the product's ordinary
  `PLURNK_MODEL` cascade: an invoking-shell value, then the XDG operator file,
  then the committed benchmark default. Harnesses admit no positional or
  benchmark-specific candidate selector. Distinct actors such as a requiem
  witness, judge, or child retain their named selector and deliberately inherit
  the resolved candidate when their contract permits an unset value. Covered:
  `host-paths.test.ts`, `smoke.test.ts`, and `[§config-model-default]` in
  `benchlet.test.ts`.
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
- §config-gbnf-optout `PLURNK_BENCH_NO_GBNF=1` forwards `PLURNK_PROVIDERS_GBNF=0` and drops the
  operator's grammar setting from the carried manifest — an explicit override for a route that
  cannot carry a grammar. The service ships no grammar of its own (plurnk-service #588); the knob
  is the path of an operator's file, so a manifest that carries one must also make that file
  reachable inside the container, which the harness does not do today.
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
  its answer to the container's `/submit_agent_response`. Covered: `test_driver.py`.
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

`terminal_bench/frontier.manifest.json` names the frozen selection of [FrontierHarness Eval v1](https://github.com/runta-dev/frontier-harness-eval): 21 Terminal-Bench 2.1 tasks (Harbor dataset `terminal-bench/terminal-bench-2-1`) and 9 DeepSWE v1.1 tasks, each once, with the published model route. `terminal_bench/frontier.sh` runs them serially by default through the existing Harbor agent (`terminal_bench/plurnk_agent.py`), one Harbor job per task; `PLURNK_BENCH_JOBS` deliberately opts into concurrency. Every client timeout is that task's own `[agent] timeout_sec` minus the boot-and-shutdown headroom (`deepswe/smoke.sh`'s 120 s); a Harbor job carries one agent-kwarg set and the budgets differ per task. The plan is read from the task dirs before any launch (`--preflight` stops there), a run directory records manifest, plan, and provenance, and the summary reads Harbor's `verifier/reward.txt` per job: pass, fail, or missing — a task without a trial is never a fail. It reports pass rate over scored tasks and task-weighted medians for cost per successful task, cost per scored task, successful-task cache-read ratio, and successful-task Harbor trial wall time; incomplete telemetry remains visible as reported/eligible coverage rather than being imputed. The DeepSWE nine run through Harbor here for one mechanism per comparison; Pier remains the DeepSWE publication path ({§benchlet-diagnostic}, {§results-canon}), and a frontier run is a diagnostic beside published harness results, never a corpus record. Corpus state stays downloaded under `.cache/`, never committed.

### §frontier-egress-probe Restricted inference connectivity

`terminal_bench/network_probe.py` exercises the original task image and Harbor's
phase-policy resolver without model inference or credentials. It installs the
explicit published client/service versions, then compares public baseline,
agent-only hostname allowance, the original agent restriction, and restored
baseline. It records DNS and unauthenticated HTTPS results for the allowed and
unrelated destinations; a pre-resolved-address probe distinguishes DNS failure
from HTTPS filtering. Success requires both public controls to respond, the
allowed provider to resolve and respond during its allowed phase, and denied
HTTPS destinations to remain unreachable even with pre-resolved addresses.
Harbor version, package pins, task-file hashes, phase policies, and results are
retained. The probe never executes or modifies the task's verifier and is not
an oracle result or proof of verifier isolation.

### §frontier-task-root Container task membership

| Task working directory | Plurnk root | Membership |
| --- | --- | --- |
| Inside a Git repository | Task working directory | Automatic tracked membership ({§membership-baseline} in plurnk-core); no harness member definition. |
| Plain directory below `/` | `/` | Only that directory's subtree, expressed relative to `/` (e.g. `PLURNK_MEMBERS_TASK=app/**`); `app/x` and `/app/x` identify the same resource. |
| Plain `/` | None | Reject before daemon startup; do not admit the entire container filesystem. |

### §frontier-trial-state Trial state and oracle verdict are independent

| Evidence | Reported state |
| --- | --- |
| No trial directory | `unstarted` |
| Trial without a finished result | `unfinished` (not proof that a process is still running) |
| Finished `CancelledError` | `cancelled` |
| Other exception before agent execution | `setup-error` |
| Other exception after agent execution began | `execution-error` |
| Finished without exception | `completed` |

Preserve the exception type alongside the state. Only `verifier/reward.txt` determines pass/fail; a passing oracle can coexist with a teardown error, and an installation-only result has no oracle verdict.

### §frontier-evidence Evidence survives agent termination

- The daemon writes `plurnk.db` directly into Harbor's retained agent log directory. Abrupt termination retains the database and its SQLite WAL sidecars; no post-run copy or signal trap is required to preserve committed records.
- Normal exit and handled signals terminate and join the exact launched daemon. Startup failure remains a runner failure, not a completed agent trial. Client failure retains its exit code and any JSON record; the unchanged verifier determines success.
- Mid-run inspection uses SQLite backup, never a raw copy of a live database. Keep WAL sidecars with an abruptly terminated database until SQLite recovers it.
- Cost summaries preserve the service's recorded USD amounts and disclose request-level charged, estimated, and unknown cost counts. Estimates are not presented as bills; missing charges are not imputed.

### §frontier-setup-evidence Installation diagnostics

- Installation writes both output streams and phase markers directly to Harbor's retained `agent/setup/install.log` while running, including before a setup timeout or cancellation. No environment dump or shell tracing is recorded.
- A completed installation records its actual exit status; pipeline logging must preserve a failed installer's status and stop subsequent steps. An interrupted log is not evidence of successful setup.
- Installation compatibility probes use Harbor's `--install-only` path: the original task environment and installed-agent setup, without model inference or verification.
- Official Debian/Ubuntu archive URLs use HTTPS with normal certificate verification. Repository hosts, suites, packages, and third-party source definitions remain unchanged; installation does not modify task instructions or verifiers.
