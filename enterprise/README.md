# Enterprise-Bench family

Drives [DevRev Enterprise-Bench](https://github.com/devrev/enterprise-bench) L1-L2 — 14
cross-system tasks over Jira-style PM, Salesforce-style CRM, and Drive-style file-server
MCP services — through the ordinary plurnk client/service boundary under
[Harbor](https://github.com/harbor-framework/harbor), the benchmark's own harness.
Contracts: [SPEC.md §enterprise](../SPEC.md).

- `driver.py` — the Harbor agent (`-a driver:PlurnkAgent`): installs the pinned daemon +
  client into the task image, declares the benchmark's MCP services as plurnk HTTP MCP
  servers, runs one headless, web-free loop, and persists the client record, DB snapshot,
  and the answer the model submitted.
- `smoke.sh` — the carry-manifest runner: pins the corpus, builds the base image, starts
  the MCP services, forwards the minimal model manifest, runs Harbor, publishes.

The model submits its own answer, as every task instructs (one POST to the container's
`/submit_agent_response` via `EXEC [sh]`); the harness never answers for it.

## run

```sh
enterprise/smoke.sh eng-l1-a deepdumb                        # one task, one trial
PLURNK_BENCH_PROFILE=comparison enterprise/smoke.sh all deepdumb   # 14 tasks × 3 trials
PLURNK_BENCH_PROFILE=canonical enterprise/smoke.sh all deepdumb    # 14 tasks × 10 trials
```

Needs `harbor`, `docker`, `unzip`, the model alias's provider credentials, and
`OPENAI_API_KEY` for the benchmark's judge — all from the invoking shell. Each task
container reserves 2 GB; `PLURNK_BENCH_JOBS` (default 3) bounds concurrency.

Results land in `jobs/` (Harbor's tree: `agent/plurnk.json`, `agent/plurnk.db`,
`agent/responses.jsonl`, `verifier/reward.txt`, `verifier/judge_result.json`) and are
published to `../benchmarks/run<N>` with record, digest, and requiem.
