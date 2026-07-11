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

In order: client error doc → `error`; `timedOut` → `timeout`; `finalStatus 499` →
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

- `patchLines` — total lines in the graded patch; empty patch → 0.
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
loop doc carried `session`+`runId` → scoped handle; crash/error doc but a DB was copied →
`dbPath`-only handle (digest renders the whole DB); no DB copied → no handle, honestly
absent — the bench never fabricates one.
Covered: `ingest.test.ts [§digest-boundary]` ×2, `digest.test.ts [§digest-boundary]` ×2,
`record.test.ts [§digest-boundary]`.

## §record-serial The record is a store row

`BenchRecord` round-trips through JSON without loss — it serializes 1:1 to `record.json` /
a JSONL line.
Covered: `record.test.ts [§record-serial]`, `[§verdicts]`.

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

## §config-carry The runner carries authoritative config, re-declaring nothing

`deepswe/smoke.sh` reads the daemon's config from its authoritative sources IN PLACE —
model layer from `~/.plurnk/.env`, provider env from the shell — and forwards every set
`PLURNK_*` / `*_BASE_URL` / `*_API_KEY` to the in-container daemon via `--agent-env`. The one
container-boundary transform: loopback (`127.0.0.1`/`localhost`) in a `*_BASE_URL` rewrites
to the host LAN IP. **All uncovered** — smoke.sh has no test harness; contracts hold by
review. Child contracts:

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
- The client surface default: `PLURNK_WS` → the daemon's WebSocket (`:3046`); `:3044` is the
  AG-UI surface (the 0.67+ client's own default target).
