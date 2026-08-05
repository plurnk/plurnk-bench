# MCP-Atlas benchlet

This harness runs an MCP-Atlas task through a real Plurnk model packet while
keeping the protocol claim precise:

- The Atlas image owns the task sandbox, data, and HTTP tool facade.
- `adapter.ts` projects only the task's enabled tools through MCP revision
  `2026-07-28`.
- Plurnk connects as a strict current MCP host and exposes the server as
  `EXEC[atlas]`.
- The candidate workspace is headless and Git-free, with every executor except
  `atlas` disabled, matching Atlas's task-tool boundary.
- The model must call an executable tool; an answer without an `EXEC` does not
  pass the diagnostic.

Atlas's bundled servers use older and mixed MCP revisions. The adapter does not
claim that they are current. It preserves Atlas's task and sandbox boundary
while making the Plurnk-facing protocol boundary current and explicit.

Run the documented filesystem task with the configured default model:

```sh
PLURNK_BENCH_ATLAS_CLIENT_ROOT=/path/to/open-client npm run atlas
```

Run a pinned public Atlas task and score its three ground-truth claims with
Atlas's own claim-coverage scorer:

```sh
PLURNK_BENCH_ATLAS_CLIENT_ROOT=/path/to/open-client \
  npm run atlas -- --task fantasy-sports-average
```

Select another configured model alias:

```sh
PLURNK_BENCH_ATLAS_CLIENT_ROOT=/path/to/open-client npm run atlas -- glm
```

The outside client checkout is an explicit precondition. The harness never
guesses a sibling under the shared parent directory.

Every run is allocated directly under `../benchmarks/` as one descriptive
`run<N>-atlas-*` directory. It contains the exact source and container
provenance, Atlas tool catalog, build and candidate logs, Plurnk database,
digest, packets, reasoning, result, and optional requiem. Scored tasks also
include the pinned dataset row, model response, scorer logs, per-claim verdicts,
and Atlas coverage statistics under `atlas-scoring/`.

A task is skipped before inference when the pinned Atlas fixture does not
expose its complete official tool allowlist. The harness does not narrow the
allowlist or add compatibility behavior to make a stale specimen run.
