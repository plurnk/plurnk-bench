# plurnk-bench

Benchmarking harnesses for [plurnk-service](https://github.com/plurnk/plurnk-service). Drive real benchmark task sets (DeepSWE first) through the [plurnk](https://github.com/plurnk/plurnk) client against a running daemon; store, score, summarize, and forensically diagnose the runs.

## shape

```
src/        shared bench core — DRY across every harness
deepswe/    one folder per harness; DeepSWE is the first
```

The core owns the cross-harness primitives: the result record (`BenchRecord`), streaming summarization (`Summary`), and — landing next — the daemon `Runner`, result store, and diagnostics. A harness adapts one benchmark's task format to that core: load tasks → drive each as a plurnk run → score with the benchmark's oracle → record.

## two verdicts, never conflated

- **`status`** — plurnk's terminal SEND code. How the *agent loop* ended (`200` ok, `499` cancelled, `4xx`/`5xx` failed).
- **`outcome`** — the *harness oracle*'s score. Whether the benchmark accepted the result (DeepSWE: do the repo's tests pass against the patch?). A loop can end `200` and still fail the oracle. The harness owns this; loop status never sets it.

## run

```
plurnk-service start          # the daemon under test — separate process
npm test                      # lint (tsc --noEmit) + unit (node --test)
```

Bench is a daemon client: it attaches to `PLURNK_WS` (default `ws://127.0.0.1:3044`), never starts a daemon. Model under test is the daemon's `PLURNK_MODEL` (`gemma` baseline). See `.env.example`.

## license

MIT.
