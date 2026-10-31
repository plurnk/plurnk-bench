# plurnk-bench — Specification

Canonical contracts for `BenchRecord`, published `benchmarks/run<N>` artifacts, host-side benchlets, container execution, and benchmark corpora.

## §verdicts 1. Verdicts, Turn Provenance, and Attempt Telemetry

`BenchRecord` carries two independent judgments and never lets one set the other:

| Field / Group | Authority & Rule |
| --- | --- |
| `status` | Client terminal loop status: how the agent loop ended (`200` ok, `499` cancelled, `4xx`/`5xx` failed). |
| `outcome` / `reward` / `testPassFraction` | Benchmark oracle score (e.g. Pier's verifier running repository tests against `model.patch`). A `200` loop can fail the oracle; the oracle never inherits loop optimism. |
| Oracle ground truth for `pass` | `reward === 1` yields `outcome = "pass"` regardless of how the loop ended (including `499` cancelled or timed-out loops whose patch passes all tests). |
| Non-pass failure classification | Precedence when `reward !== 1`: client Problem doc -> `error`; `timedOut` -> `timeout`; `finalStatus === 499` -> `cancelled`; oracle never graded (`reward.json` absent) -> `error`; else `fail`. Pier exceptions (`AgentTimeoutError`, `VerifierTimeoutError`) reclassify `error` to `timeout` without overwriting a landed loop doc verdict. |
| Turn count provenance (`turns`) | Precedence: `turns[].length` -> `turnCount` -> `0` (client `turnCount` reports `0` on abnormal termination even when turns ran; error-only crash docs without `turns[]` report `0` in `record.json` while the digest retains the DB turn count). Never opens the daemon DB directly ({§digest-boundary}). |
| `patchLines` | Textual lines in Pier's graded `model.patch`, excluding Git encoded binary payloads (`0` on empty patch). |
| `filesModified` | Existing files changed (`diff --git` count minus `new file mode` count). New files alone modify `0` existing files (`NO-ATTEMPT`). |
| `p2pRegressed` | `true` iff `p2p_passed < p2p_total`, `false` when the counted suite fully passes, absent only when `reward.json` carries no p2p counts ("not regressed" and "not measured" never share a spelling). |
| `testPassFraction` | Meaningful only when `outcome` is `pass` or `fail`; on `error`/`timeout`/`cancelled` it reflects the base repository grade, not progress. |
| Composed failure modes | `filesModified === 0` -> `NO-ATTEMPT`; `filesModified > 0 && p2pRegressed` -> `BROKE-THE-BUILD`; `filesModified > 0 && !p2pRegressed && testPassFraction < 1` -> `NEAR-MISS`. |

## §accounting-cost-completeness 2. Campaign Reporting, Cost Completeness, and Cache Effectiveness

- **DeepSWE campaign reporting (`deepswe/report.ts <job-directory>`)**: Joins finished Pier trial records to published workspace digests. Binary oracle rewards determine pass rate; ungraded trials remain separate. Cost, cache, and duration medians are task-weighted and state reported/eligible coverage. Unknown accounting is never `0`. Request cost provenance distinguishes `charged`, `estimated`, and `unknown` amounts. Duration is client agent-loop wall time (`wallMs`). Saved runner counts are timestamped snapshots, not liveness assertions. Repeated attempts for one task require explicit selection rather than best-result picking.
- **Upstream baseline comparison (`--baseline <trials.json> --profile <config>`)**: Matches graded candidate tasks to the exact selected upstream configuration. All upstream trials marked `included_in_score` contribute binary `score_value` (never best-attempt picking). Missing counterpart tasks remain explicit and are excluded from both matched denominators. Peer token and agent-time medians use that matched set. Historical USD figures are not silently compared under different rate cards.
- **Cost completeness**: Reporting preserves the daemon's known USD subtotal as `knownCostUsd` and counts priced physical requests and `charged`/`estimated`/`unknown` cost evidence. `costUsd` is complete only when every request has USD evidence; unsettled requests, unknown costs, and non-USD costs without a supplied USD equivalent leave `costUsd` as `null`. Missing usage does not invalidate a directly reported charge; explicit `0` is a measured amount, not missing evidence. Campaign totals and cost-per-solve require complete trial costs; medians use complete trials only with coverage shown; task-averaged cost requires every attempt of that task. Reports retain partial known spend separately, never call catalog estimates provider bills, and never rewrite original request evidence. Requiem follows the same rule over its own request ledger. Historical digests whose `costUsd` is a subtotal are verified per request before accepting a complete cost. Missing token fields remain unknown; gross-token metrics require complete input and output counts with coverage shown.
- **Cache effectiveness (`cacheEffectiveness`)**: Measures prompt caching across the physical request ledger (every `emission` and `bare` request across sessions, retries, and rejected emissions; requiem interviews use their own ledger). Every included request must report `inputTokens` and `cacheReadTokens` (otherwise `null`). Reports token-weighted `cacheReadTokenRatio = cacheReadTokens / inputTokens` (`null` when no model requests or zero input) and includes `cacheWriteTokens` only when every included request reports them. Invalid per-request counts fail before aggregation.

## §digest-boundary 3. Evidence Boundary, Platform Packages, Record Schema, and Provenance

- **Daemon DB and package boundary**: DB interpretation belongs to `@plurnk/plurnk-service/evidence` (`EvidenceReader.open`); report and snapshot generation belong to `@plurnk/plurnk-digest` (`Digest.run`, `Share.snapshot`); runtime-neutral `Problems`, `Validator`, and types come from `@plurnk/plurnk-contracts`. Dependencies resolve from the public npm registry and committed lockfile, never a sibling checkout, workspace link, local path, or unpublished package.
- **Handle and incremental digest rules**: Bench holds `RunRef.dbPath` and issues zero raw SQL. Loop doc with `workspace` + `sessionId` -> scoped handle; crash/error doc with copied DB -> `dbPath`-only handle (whole-DB digest); no DB copied -> absent handle (`null`). Reporting reads `digest.json` incrementally, retaining accounting and outcome fields while omitting opaque provider response bodies. Invalid or unfinished JSON is an export failure, never a zero-cost or turnless result.
- **`BenchRecord` schema and serialization**: `BenchRecord` round-trips 1:1 through `record.json` / JSONL. Accepted client-document schema is version `6`: its run reference uses `workspaceId`/`sessionId`/`loopId`, ingest preserves its complete `usage` envelope, ordered physical requests are the accounting evidence ({§publish}), known aggregate token quantities remain optional, and `costUsd` is an exact decimal string or `null`. Curation `curationWeight`/`curationBudget`, physical context `contextTokens`/`contextCapacity`, and provider metadata remain sibling fields; bench never compares model-independent weight with provider tokens and does not project rates, tokens, or cost. Failed client documents preserve exact RFC 9457 `problem`; Pier exceptions map once to a `bench:pier` Problem. Earlier client schemas, legacy run coordinates, pico-USD, old `error` field, and flattened failure strings are rejected rather than translated.
- **Job-tree provenance**: Any child of `jobs/<job>/` holding `result.json` with `trial_name` (absent on job-level `result.json`) is a trial directory, supplying `task_name`, `config.agent.model_name`, Pier timing, and exceptions in deterministic directory-name order.

## §publish 4. Run Publication, Requiem Interviews, and Results Canon

`publishRun` writes `<benchmarksHome>/run<N>-<harness>-<task>-<model>/` as a plain folder (never an archive) containing `plurnk.db` (consolidated via `Share.snapshot` including `-wal` pages), `digest/` (rendered from the copy), and `record.json`.

| Aspect | Contract |
| --- | --- |
| Numbering & live launch folder | `run<N>-<harness>-<task>-<model>` sets `N = max + 1` (else `1`, non-run dirs ignored), task last path segment, and model alias. `allocateRunDirectory` may allocate the folder before daemon launch (with trial scratch `agent` linked to it) so `plurnk.db` is live from turn 1 and publication finalizes it in place (`swebench` prints `run=<folder>` at launch; preflight opens no run folder). |
| Turnless & model-attempt gates | A turn-less DB (`0` digest turns) or a DB without at least one model turn (setup/maintenance turns only) is rolled back and not published. A trial whose client record died mid-loop still publishes if its DB holds model turns. No run handle returns `null`. |
| Live watcher & self-reference | `publish.ts --watch <job> --pid <harness>` publishes each finished trial once (marking `.plurnk-bench-published`) and sweeps once more when the harness exits. `record.json` points its digest handle at the published copy, never into `jobs/`, without mutating input. |
| Digest provenance & workspace scope | If the candidate rendered `agent/digest/digest.json` beside its DB, publication copies that digest verbatim; otherwise the installed service renders it. Published digests are workspace-scoped (never narrowed to `sessionId`, preserving child session evidence while `record.json` keeps `run.sessionId` for drill-down). |
| Task & requiem accounting | Published `record.json` copies the digest's sole workspace `accounting` projection verbatim under `usage.accounting` (including child, BARE, and failed physical requests; unsettled remains `null`; primary-loop context fields retain client values or `null`; ambiguous workspace scope or inconsistent request cardinality fails publication). When `PLURNK_BENCH_REQUIEM=1`, `publishRun` invokes the service's `requiem` command (best-effort on missing witness) and folds the banked interview's accounting summary (`sessions`, `providerRequests`, `usage`, `cacheEffectiveness`, exact nullable USD) into `record.json` under `requiem` (failing hard if folding a banked interview fails). |
| Results canon (`PLURNK_BENCH_HOME`) | `~/benchmarks` (or `PLURNK_BENCH_HOME`) holds published runs at its root and harness scratch under `jobs/<harness>/`. Nothing lands inside a repository; `jobs/` is read post-hoc only for the daemon log of a 0-turn boot failure. |

## §benchlet-diagnostic 5. Pinned Host-Side Benchlet Diagnostics and Container Execution

`deepswe/benchlet.sh --task <task>` (and `atlas/benchlet.sh`) runs repeatable host-side diagnostics against checked-in task manifests (release gate specimens: `sqlite-db-truncate`, `fastapi-deprecation-response-headers`), atomically allocating `../benchmarks/run<N>-deepswe-<task>-<model>/`.

- **Provenance & explicit client checkout**: Manifests pin upstream commit, task files/hashes, environment, verifier backend, and timeouts. Runs require clean bench, service, and client commits and copy the pinned task into the run artifact. Host candidates require explicit `PLURNK_BENCHLET_CLIENT_ROOT` (DeepSWE) or `PLURNK_BENCH_ATLAS_CLIENT_ROOT` (Atlas), resolving relative paths from bench root and failing before run allocation when missing or blank.
- **Pristine baseline, tree manifests, & oracle exclusions**: Harnesses prove the pristine baseline before invoking a model (`grader.py prepare` + `go test -json` for ABS; pinned task image + `tests/test.sh` requiring consistent `reward.json` and `ctrf.json` for Docker). Terminal-Bench 2.1 tree manifests (`kind: "terminal-bench"`, pinned by `pin-task.mjs --terminal-bench`) copy `/app` out as the candidate tree, set `PLURNK_MEMBERS_task=**`, rewrite `/app` in the instruction to the host tree, grade sorted file sha256 state over a fresh container's `/app` via `tests/test.sh` (`reward.txt` and `ctrf.json` must agree), and require a pristine baseline grade of `0`. Baseline-failing `p2p_node_ids` leave the graded set for that run only (recorded in `oracle-exclusions.json` and `result.json.oracle.environmentExcludedP2p`, merged into `config.json`; `> 1` exclusion must not exceed `1/10` of the p2p set; f2p tests are never excused; `--preflight` lists exclusions).
- **Container execution & scratch (`CandidateContainer`)**: For Docker manifests, `src/candidate-container.ts` starts one long-lived container with manifest network/CPU/memory limits, bind-mounts the repo at its host path and `/app`, `chown -R`s the image's default `$HOME` (never empty or `/`) to the host user, and places executor shims (`sh`, `bash`, `node`, `python3`, `npm`, `cargo`, `go`, ...) in front of the daemon's `PATH` carrying literal container id, repo path, user, and host `PATH` (forwarding commands into the container when cwd is inside the repo and running host binaries otherwise). It creates `0700` `<run>/exec-scratch` (`<trial>/exec-scratch` for SWE-bench, refusing relative paths), bind-mounts `-v <dir>:<dir>`, exports `PLURNK_SERVICE_EXEC_SCRATCH=<dir>` via `CandidateContainer.daemonEnvironment()`, and writes `candidate-execution.json` (`kind: "task-container"` or `"host"`, `image`, `network`, `container`, `home`, `scratch`, `mounts`, and shim set).
- **Candidate isolation (`src/candidate-isolation.ts`)**: Sets `<alias>_ENABLED=0` and family defaults `0` for operator MCP aliases and operator `PLURNK_SKILLS_<name>` definitions (including Unicode and digit-leading names) without blanking definitions, denies `web` and `mcp` in `PLURNK_SERVICE_CAPABILITIES`, sets `PLURNK_SCHEMES_HTTP_HOSTS=[]`, blanks `BRAVE_API_KEY` and `TAVILY_API_KEY`, and writes `candidate-isolation.json` (campaign sheets report web references taught in the first packet beside refused attempts).
- **Two patches, exit classification, evidence, & requiem witness**: Grades both `model.patch` (`base..HEAD` committed submission) and `working.patch` (committed, tracked, and untracked working state) distinctly. `result.json` (schema version `2`) records `providerRequests` (physical cardinality), `rejectedEmissions` (admission evidence), native provider usage, exact decimal string or `null` USD totals, and sets `candidate.outcome = "finished"` only on clean exit; timeout, spawn failure, or non-zero exit sets `harnessStatus = "candidate_failed"`, and a zero-byte submission diff sets `oracle.submissionEvidence.emptyPatch`. `PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC` accepts a positive cap or `-1` (no limit). Failure summaries count causal incidents (one per failed op or shared session-owned stream address) and underlying observation rows. Asynchronous children share the benchlet cancellation signal, draining stdout/stderr before evidence is finalized while a harness watchdog is distinctly recorded as `timedOut`. Zero physical provider requests or interrupted runs record terminal infrastructure failure. Requiem requires explicit `PLURNK_BENCHLET_REQUIEM_MODEL` (never falling back to candidate alias) and both `requiem.md` and `requiem.json`.

## §pair-sheet 6. Paired Harness Comparison and Mini Trajectory Digest

- **Paired run (`deepswe/pair.sh --task <task>`)**: Runs a pinned DeepSWE task sequentially through the plurnk benchlet ({§benchlet-diagnostic}) and Pier's `mini-swe-agent` on the same model route under `<benchmarks>/jobs/pairs/<task>-<alias>-<stamp>/` (`plurnk/`, `mini/`, `pair.json`, `facts.json`, `PAIR.md`; a second run on either side is an error).
- **Route, fact shape, budget, & flags**: Plurnk uses `--alias` (default `PLURNK_MODEL`); mini resolves `deepswe/pair.aliases.json` (`-m` model, endpoint, key env var name, reasoning effort; unmapped alias refused; `pair.json` records the key variable name). Both sides project into one fact shape (`state`: `complete`/`failed`/`skipped`/`absent`, `model`, `reward`/`f2p`/`p2p`/`partial`, `steps`, `providerRequests`, `tokens`, candidate `cost` excluding requiem, agent and harness wall time, loop exit; unsupplied facts are `absent`, never `0`). Mini uses task `[agent] timeout_sec`; plurnk uses `PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC`. Supports `--preflight`, `--skip-plurnk`, `--skip-mini`, and `--sheet <pair>`.
- **Mini trajectory digest (`deepswe/mini-trajectory.ts`)**: Reads `agent/mini-swe-agent.trajectory.json` (OpenAI Responses objects interleaved with `function_call_output` observations) into `<trial>/digest/steps.md` and `steps.json` (assistant words, reasoning summary, bash command, return code/line count/head, per-response and total usage, exit status, and submission; missing usage is `null`, never `0`).

## §bench-relock 7. Known Confounds and Frozen Lane Relocking

| Confound | Status |
| --- | --- |
| Host toolchain vs task image | Fixed via PATH shims into one long-lived task container ({§benchlet-diagnostic}), recorded in `candidate-execution.json`. |
| Baseline-failing p2p tests | Recorded and excluded per run in `oracle-exclusions.json` and `result.json.oracle.environmentExcludedP2p`. |
| Per-alias effort, service tier, & sampling | Recorded in `provenance.aliasConfiguration` (`PLURNK_MODEL_<alias>`, `_EFFORT_`, `_SERVICE_TIER_`, `_TEMPERATURE_`, `_REPEAT_PENALTY_`, capacity knobs; never credentials) and `pair.json`. |
| Upstream `trials.json` provider difference | Fixed inside a pair by sharing the endpoint in `pair.aliases.json` ({§pair-sheet}); upstream `trials.json` comparisons remain provider-confounded. |
| Candidate timeout vs task timeout | Recorded on the pair sheet ({§pair-sheet}); `.env.defaults` sets candidate timeout to task budget minus boot headroom. |
| Language & requiem version | Recorded in `provenance.sources` from clean commits (post-`d88b3543` fences boundary; lanes older than `24d9de148` set `PLURNK_BENCHLET_REQUIEM=0`). |
| Image drift | Manifest pins image and provenance records resolved `imageId`. |
| Wall-clock contention | A pair runs its two sides sequentially ({§pair-sheet}). |

`deepswe/relock.sh <service-ref> <client-ref> [<lanes-root>]` points detached worktrees at `../bench-lanes/plurnk-service` and `../bench-lanes/plurnk` (or explicit `<lanes-root>`), runs `npm ci`, installs the built platform's projected contracts tarball into the client before building without mutating manifests or lockfiles, and prints `PLURNK_BENCHLET_SERVICE_ROOT` and `PLURNK_BENCHLET_CLIENT_ROOT`.

## §config-carry 8. Authoritative Configuration Carriage and WAL Snapshots

`deepswe/smoke.sh` reads daemon configuration from the shell/XDG/committed-default cascade and `${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env`, forwarding every set `PLURNK_*`, `*_BASE_URL` (rewriting `127.0.0.1`/`localhost` to host LAN IP), and `*_API_KEY` via `--agent-env`:

| Contract | Rule |
| --- | --- |
| Unattended default | `.env.defaults` sets `PLURNK_EXECS_PLURNK_QUESTION=0`, removing the question tool and `mcp:///plurnk_question.md` across DeepSWE, Terminal-Bench, and host benchlets. |
| Candidate model cascade | Resolves `PLURNK_MODEL` from invoking shell -> XDG operator file -> committed benchmark default; harnesses admit no positional candidate selector. |
| Image prepull | `deepswe/prepull.sh [task-glob\|all]` pulls task images before `pier run` with bounded parallelism (default `3`), backoff retries, and a `40 GB` Docker disk floor. |
| Egress allowlist | Derived from `providers.json` registry hosts, forwarded `PLURNK_BASEURL_<alias>` or `<PROVIDER>_BASE_URL`, and Tavily when routed; fails trial when no model egress is named. |
| Digest version preflight | Installed `@plurnk/plurnk-service` must equal the corpus version or launch is refused. |
| Decoupled live publisher | `publish.ts --watch` runs beside `pier`, followed by one idempotent final `publish.ts <job>` pass and trap cleanup of `pier`, publisher, and sampler. |
| Failed setup & resource samples | 0-turn environment failures are listed in `<job>/failed-setup.txt`; `docker stats` is sampled once a minute into `<job>/docker-stats.jsonl` (`t` = UTC sample time). |
| Bench namespace & GBNF opt-out | `PLURNK_BENCH_*` knobs (`PLURNK_BENCH_HOME`, `PLURNK_BENCH_HARNESS`, `PLURNK_BENCH_REQUIEM`, `TIMEOUT_SEC`, `CPUS`, `FORCE_BUILD`, `NO_GBNF`) are excluded from daemon forwarding; `PLURNK_BENCH_NO_GBNF=1` forwards `PLURNK_PROVIDERS_GBNF=0`. |
| Budget, CPUs, surface, & versions | Client timeout is `[agent] timeout_sec` minus headroom; container uses native task CPUs unless `PLURNK_BENCH_CPUS` is set; client/daemon use default ACP v2 (`PLURNK_HOST`, `PLURNK_PORT`, `PLURNK_ACP_URL`); exact npm versions pass as driver kwargs. |
| Tavily route & WAL snapshot | Forwards `TAVILY_API_KEY` when set and records configured/absent and `basic`/`advanced` depth. Snapshots live `plurnk.db` via SQLite online `backup()`, failing the trial if a consolidated WAL snapshot cannot be produced. |

## §enterprise 9. Enterprise-Bench L1–L2 Family and Specimens

DevRev Enterprise-Bench runs through the ordinary plurnk client/service boundary under Harbor against `devrev/enterprise-bench` pinned at one clean detached commit (`truefoundry/trueforge@b11cfc3b` is a reproducibility reference only):

- **Profiles & budget groups**: `single` (1 trial/task), `comparison` (3), and `canonical` (10, 140 observations) are never conflated. Tasks are grouped by `[agent] timeout_sec` (`600` s and `900` s for `sales-l2-a`/`sales-l2-d`) into `.cache/enterprise-groups/<budget>/` views and run with budget minus headroom.
- **MCP carriage & candidate posture**: Harbor's `mcp.json` expands into `PLURNK_MCP_<alias>` complete `McpServerDefinition` JSON (alphanumeric alias e.g. `file-server` -> `fileserver`, `host.docker.internal` rewritten to host LAN IP, recorded in `agent/plurnk-mcp.json`, operator MCP fleet excluded). Candidate runs at `/workspace` (Git-free, web-free, non-interactive, shell + benchmark MCP executors only) and POSTs its answer to `/submit_agent_response` (retained as `agent/responses.jsonl`; harness never submits on model's behalf).
- **Oracle, spend, & host specimen**: Graded by Harbor's `verifier/reward.txt` (binary at `1`, with `judge_result.json` retained and shell judge key required preflight); spend uses daemon accounting (`deepdumb` before `glm`). `enterprise/specimen.sh <task> [model]` runs one task against a host checkout daemon (`scripts/candidate.mjs` + `PLURNK_CLIENT_CHECKOUT`, isolated `XDG_CONFIG_HOME=<run>/config`, `PLURNK_SERVICE_ROOTS=plurnk`) into `run<N>-enterprise-specimen-<task>-<model>`.

## §frontier-evidence 10. FrontierHarness Eval v1 Parity Lane and Egress Probe

`terminal_bench/frontier.manifest.json` pins 21 Terminal-Bench 2.1 and 9 DeepSWE v1.1 tasks run by `terminal_bench/frontier.sh` and `terminal_bench/plurnk_agent.py` (serial by default, `PLURNK_BENCH_JOBS` concurrency, timeout `[agent] timeout_sec - 120`, `--preflight`, summary over `verifier/reward.txt` reporting pass rate and task-weighted medians). `terminal_bench/network_probe.py` verifies public baseline, agent-only hostname allowance, original restriction, and restored baseline via DNS, unauthenticated HTTPS, and pre-resolved IP probes.

| Task working directory | Plurnk root | Membership |
| --- | --- | --- |
| Inside a Git repository | Task working directory | Automatic tracked membership in plurnk-core; no harness member definition. |
| Plain directory below `/` | `/` | Only that directory's subtree, expressed relative to `/` (e.g. `PLURNK_MEMBERS_task=app/**`); `app/x` and `/app/x` identify the same resource. |
| Plain `/` | None | Reject before daemon startup; do not admit the entire container filesystem. |

| Trial Evidence | Reported State |
| --- | --- |
| No trial directory | `unstarted` |
| Trial without a finished result | `unfinished` (not proof that a process is still running) |
| Finished `CancelledError` | `cancelled` |
| Other exception before agent execution | `setup-error` |
| Other exception after agent execution began | `execution-error` |
| Finished without exception | `completed` |

Exception type is preserved alongside state; only `verifier/reward.txt` determines pass/fail. Daemon writes `plurnk.db` + WAL directly into Harbor's retained agent log dir (inspected mid-run via SQLite `backup()`). Installation streams stdout/stderr and phase markers to `agent/setup/install.log`, preserves failed installer exit status, supports `--install-only`, and uses verified HTTPS Debian/Ubuntu archive URLs.

## §swebench-evaluator 11. SWE-bench Lite Corpus, Official Evaluator, and Trial Runtime

`swebench/` drives pinned SWE-bench Lite tasks through the ordinary plurnk client/service boundary and grades with the official evaluator (`swebench/evaluator.ts` -> `RewardJson`).

- **Corpus & sampling**: `swebench/pin-task.mjs` writes `swebench/manifests/<instance>.json` including `datasetRevision` (cache in `.cache/swebench`). `swebench/sample.ts` draws deterministic hash-seeded `uniform` or `stratified` corpora under `swebench/corpora/<label>.json`.
- **Official evaluator & recovery**: Translates official per-instance report (must name requested instance with boolean `resolved`) into `RewardJson`; empty prediction scores `{reward: 0, empty_patch: 1}`; absent report or infra failure is `null`. Evaluator-only recovery reuses the same instance, label, and patch SHA-256 without invoking a model (settling under `--halt-on clean` and Pi driver, or regrading/skipping abnormal evaluator exits under `--halt-on pass`).

| Evidence | Lifetime and Effect |
| --- | --- |
| `oracle/<runId>/` | One grading attempt: exact prediction, subprocess stdout/stderr, official reports, and `evaluation.json` recording running/finished state, exit status, diagnostics, and reward. |
| `verifier/evaluation.json` | Latest attempt, including failure independently of the oracle verdict. A trial whose report exists publishes whatever that exit was ({§publish}); only an absent report leaves the trial ungraded and unpublished. |
| `verifier/reward.json` | Latest valid oracle verdict. A failed reevaluation cannot erase an earlier verdict for the same candidate. |

- **Trial directory, provenance, & disk preflight**: Announces `artifact=` on allocation, uses unique evaluation run ids (`sweb.eval.<instance>.<run_id>`), writes `provenance.json` before and after publication, sets `result.json.exception_info = null` only on clean exit, checks `PLURNK_SWEBENCH_MIN_FREE_GB` (default `15`, `0` disables), and honors `PLURNK_SWEBENCH_PRUNE_IMAGE=1`.
- **Network, container runtime, & model account**: Harbor enforces `PLURNK_SWEBENCH_MODEL_HOSTS` (JSON array), optional read-only `PLURNK_SWEBENCH_RESOLV_CONF` snapshot at `/etc/resolv.conf` (recorded with SHA-256), and {§benchlet-diagnostic} isolation; host-loopback model endpoints (`127.0.0.1:<port>` / `localhost:<port>`) are bridged into container loopback over an owner-only Unix socket in `/var/lib/plurnk` with no external network required. The whole candidate runs inside the task image at `/testbed` with UTF-8 process I/O preflight, provisioned Node at `/usr/local/bin/node`, `/opt/plurnk` at `0700`, `/var/lib/plurnk` owner-only, executor subprocesses running as `PLURNK_EXECS_SPAWN_USER=plurnk` (uid `60007`, home `/home/plurnk`), and group-writable `/testbed` (setgid directories, daemon umask `002`).
- **Conditions & prompt**: Runs `--yolo` with `PLURNK_SERVICE_PROPOSALS=accept` and `PLURNK_PROVIDERS_EFFORT_<alias>`. Wraps the verbatim official issue in `<issue>` followed by repair/verification instructions and the no-network bound, recorded in `provenance.json`.

## §swebench-comparison 12. SWE-bench Campaigns, Matrix, Friction, and Statistical Comparison

- **Campaigns (`swebench/campaign.sh`, `swebench/plan.ts`)**: Runs 3 attempts x 30 tasks under `PLURNK_BENCH_JOBS` (default `1`), halting at the first non-clean pass or under `--halt-on clean` only on non-clean exit (decorating engine-ended passes as `pass (turn ceiling exhausted)` and verdictless engine terminals as `fail: <cause>`). `--resume` skips completed pairs and `--skip` ids persisted in `accepted`. Manifest turn cap bounds each attempt, with wall clock as a runaway guard.
- **Profile matrix (`swebench/matrix.mjs`)**: Rotates profile order across instances and repetitions through `swebench/run.sh`, recording an immutable plan and append-only launch/results records while draining in-flight trials on missing evidence or interruption without auto-retry.
- **Friction & statistical comparison (`swebench/friction.ts`, `swebench/report.ts`, `swebench/comparison.ts`, `src/statistics.ts`)**: Reports digest EDIT census (`count/refused/revisits`) and overlapping friction views, followed by task-averaged pass rates, 10,000 hash-seeded bootstrap resamples for 95% confidence intervals, paired sign-flip permutation tests with Holm correction against K3 baselines (wins, losses, ties), cost per solve, and rollout medians (with catalog vs study direct-API pricing noted as a confound).

| Friction View | Evidence and Meaning |
| --- | --- |
| Model turns | Distinct `turn_attempts.turn_id`; copied history and runtime turns are not new model work. |
| Fence-free content | Raw `turn.program` has no backtick fence opener (format observation, not failed admission; missing source is unknown). |
| Admitted fence-free content | Fence-free turn carrying an engine emission receipt (`attrs.kind=emission`, e.g. from native-call recovery). |
| No-operation turns | Distinct attempted turns with an engine `error` receipt for `engine/rail/no-operation`. |
| Failed receipts | Status `>= 400`, grouped by family and provenance (authored model work, automatic runtime, ambient, inherited history, or unknown; inheritance takes precedence). |
| Failed execution streams | `READ` receipts carrying an `executor/*` Problem, grouped by resource URI without channel fragment within one trial. |

### §swebench-pi 12.1 Native Pi Comparison

`swebench/pi.mjs` and `swebench/pi-campaign.mjs` run the installed Pi CLI (`PLURNK_BENCH_PI`) over the same corpus/attempt plan, supporting `openrouter`, `deepseek`, `fireworks`, or custom `baseUrl`/`api`/`contextWindow`/`maxOutputTokens` profiles (writing `models.json`).

| Boundary | Contract |
| --- | --- |
| Agent | Stock system prompt, default tools, sampling, output/retry behavior, and stock compaction unless profile declares `contextWindow` with `compaction.reserveTokens` and `keepRecentTokens`; frozen version and catalog; no request-payload rewriting. |
| Personal context | Fresh Pi configuration per trial; no operator/project extensions, skills, prompt templates, AGENTS/CLAUDE files, or Plurnk teaching. |
| Environment | Reuses {§swebench-evaluator} trial, network, and container runtime (keeping image user and `/testbed` ownership for Pi tools) on the same provisioned Node runtime. |
| Limits | Benchmark-only extension aborts before the next model turn beyond the declared cap; common wall-clock guard applies; no model-facing instructions added. |
| Evidence | Observes native Chat Completions or Messages requests and responses without mutation; retains raw streams, Pi JSON events, session files, configuration, errors, patch, and official oracle. |
| Cost | OpenRouter `cost` (+ `cost_details.upstream_inference_cost` when `is_byok` is true) owns charged cost; Messages usage merges cumulative counters after terminal event; `llama-server` `timings` terminal chunks settle streamed `reasoning_content` token frames when `completion_tokens_details.reasoning_tokens` is absent; responses without a charge use explicitly labeled fixed-rate repricing (including optional `rates.reasoning`). |
| Failure | Grades available work regardless of agent outcome; adapter/setup failures, absent requests/verdicts, and evaluator process failures pause for review while preserving saved verdicts. |

Pi trial and campaign `chargedUsd` and `repricedUsd` are `null` unless every request supplies the respective charge or complete rate-card token breakdown; `knownChargedUsd` and `knownRepricedUsd` preserve available subtotals (`null` when none is known); `usage` contains only complete per-field totals while `knownUsage` carries available subtotals.

## §tier-corpus 13. Live and Demo Specimen Tiers and Story Oracles

- **Live and demo tiers (`tiers/`)**: `npm run tier:live` (`tiers/live/`) and `npm run tier:demo` (`tiers/demo/`) run full tiers or `--specimen <name>` (refusing unknown names before any model call) against `PLURNK_BENCHLET_SERVICE_ROOT` and `PLURNK_BENCHLET_CLIENT_ROOT`, resolving `@plurnk/plurnk-service/harness` from the target service checkout and writing `provenance.json`, `census.md`, `census.json`, `result.json`, and per-session `record.json` and `digest/` under `<benchmarksHome>/tier-<live|demo>-<stamp>/`.
- **Demo story oracles (`tiers/demo/_*-oracle.ts`)**: Graded by oracle, never model claims. Script oracle requires daemon-observed execution (terminal receipt, native script, or shell command with observed successful output) and rejects claimed, unobserved, failed, unrelated, or mismatched runs (allowing verification around the run). Web oracle requires the actual latest stable version (rejecting arbitrary digits, partial matches, newer maintenance dates, or LTS labels). Packet audit oracle accepts numbered findings under any Markdown emphasis.
