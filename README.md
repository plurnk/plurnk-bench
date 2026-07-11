# plurnk-bench

Benchmarking harnesses for [plurnk-service](https://github.com/plurnk/plurnk-service). Drive real benchmark task sets (DeepSWE first) through the [plurnk](https://github.com/plurnk/plurnk) client against a running daemon; store, score, summarize, and forensically diagnose the runs.

## shape

```
src/        shared bench core — DRY across every harness
deepswe/    one folder per harness; DeepSWE is the first
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

Bench is a daemon client: it attaches to the daemon, never starts one (in-container the daemon WS is `ws://127.0.0.1:3046`; `:3044` is the AG-UI client surface). Model under test is the daemon's `PLURNK_MODEL` alias. See `.env.example` and SPEC `§config-carry`.

## license

MIT.
