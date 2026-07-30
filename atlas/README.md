# MCP-Atlas benchlet

This harness runs an MCP-Atlas task through a real Plurnk model packet while
keeping the protocol claim precise:

- The Atlas image owns the task sandbox, data, and HTTP tool facade.
- `adapter.ts` projects only the task's enabled tools through MCP revision
  `2026-07-28`.
- Plurnk connects as a strict current MCP host and exposes the server as
  `EXEC[atlas]`.
- The model must call an executable tool; an answer without an `EXEC` does not
  pass the diagnostic.

Atlas's bundled servers use older and mixed MCP revisions. The adapter does not
claim that they are current. It preserves Atlas's task and sandbox boundary
while making the Plurnk-facing protocol boundary current and explicit.

Run the documented filesystem task with the configured default model:

```sh
npm run atlas
```

Select another configured model alias:

```sh
npm run atlas -- glm
```

Every run is allocated directly under `../benchmarks/` as one descriptive
`run<N>-atlas-*` directory. It contains the exact source and container
provenance, Atlas tool catalog, build and candidate logs, Plurnk database,
digest, packets, reasoning, result, and optional requiem.
