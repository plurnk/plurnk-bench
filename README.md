# plurnk-bench

Benchmarking harnesses for [plurnk-service](https://github.com/plurnk/plurnk-service). Drive real benchmark task sets through the [plurnk](https://github.com/plurnk/plurnk) client against a running daemon; store, score, summarize, and forensically diagnose the runs.

## families

| family | status |
|---|---|
| `deepswe/` | **active** — the bench; local-model target (rtx5070), revived 2026-08-31 (#17) |
| `terminal_bench/` | **revived for parity** — FrontierHarness Eval v1 lane (2026-09-02, #22): `terminal_bench/frontier.sh`, 30 tasks, one Harbor job each; the TB 4.0 leaderboard shape stays retired (#17) |
| `atlas/` | retired, revivable (2026-08-31, #16) |
| `enterprise/` | retired, revivable (2026-08-31, #16); its standing MCP fixtures are down |

Retired families keep their code, tests, and SPEC sections byte-intact so a future revival is a re-activation, not an excavation — but no gate, ritual, or run surface references them.

## shape

```
src/        shared bench core — DRY across every harness
deepswe/    one folder per harness (see families table for status)
```

The core owns the cross-harness primitives: the result record (`BenchRecord`), the trial-artifact join (`ingest`), daemon-digest reuse (`digest`), and run publishing (`publish` → `benchmarks/run<N>` with record + digest + requiem). A harness adapts one benchmark's task format to that core: load tasks → drive each as a plurnk run → score with the benchmark's oracle → record.

Contracts live in [SPEC.md](SPEC.md) — `§` tags, cited from code comments and test names (`[§tag] …`), house-style.

## two verdicts, never conflated

- **`status`** — plurnk's terminal SEND code. How the *agent loop* ended (`200` ok, `499` cancelled, `4xx`/`5xx` failed).
- **`outcome`** — the *harness oracle*'s score. Whether the benchmark accepted the result (DeepSWE: do the repo's tests pass against the patch?). A loop can end `200` and still fail the oracle. The harness owns this; loop status never sets it. (SPEC `§verdicts`.)

## run

```
plurnk-service start          # the daemon under test — separate process
npm test                      # lint (tsc --noEmit) + unit (node --test)
```

Bench drives the daemon through the ordinary `plurnk` client and its AG-UI+
HTTP/SSE surface (default `http://127.0.0.1:1066`). The model under test is the
daemon's `PLURNK_MODEL` alias. See `.env.example` and SPEC `§config-carry`.

## license

MIT.
