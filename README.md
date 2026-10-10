# plurnk-bench

Evaluation runners and forensic reporting for [Plurnk](https://github.com/plurnk/plurnk).
Run external benchmark tasks through the real client and daemon, grade the
result with the benchmark's evaluator, and retain the evidence needed to explain it.

## Choose an evaluation

| Guide | What it runs |
|---|---|
| [SWE-bench Lite](swebench/README.md) | Pinned repository issues, the official evaluator, repeatable campaigns, and native Pi comparisons. |
| [DeepSWE](deepswe/README.md) | Tasks through Pier, plus a host-side diagnostic benchlet and mini-swe-agent comparisons. |
| [Terminal-Bench / FrontierHarness](terminal_bench/README.md) | Tasks through Harbor and the checked-in FrontierHarness selection. |

Each guide owns its prerequisites, commands, and evidence paths. Older
[Atlas](atlas/README.md) and [Enterprise-Bench](enterprise/README.md) adapters
remain available for investigation; check their external prerequisites before use.

## Setup

Clone this repository and install its locked dependencies:

```sh
git clone https://github.com/plurnk/plurnk-bench.git
cd plurnk-bench
npm ci
```

Use the Node.js version required by [package.json](package.json). Evaluation
runners also need their guide's Python/container toolchain. Source-based runners
require explicit service and client checkouts; container runners install the
selected published packages. The runner owns daemon startup.

Choose a model through Plurnk's normal
[configuration](https://github.com/plurnk/plurnk-service/blob/main/plurnk-providers/README.md#configure-a-model).
Provider credentials stay in the invoking environment. Benchmark settings live in
[.env.defaults](.env.defaults); review them and select your own model before a run.
Model runs and optional exit interviews can incur inference charges.

## Read the evidence

A completed agent loop is not necessarily a solved task. Reports keep the loop's
terminal status separate from the evaluator's verdict, and distinguish missing
grades, infrastructure errors, and model failures.

Inspect the saved patch, evaluator output, and packet/reasoning digest alongside
pass rate, cost, tokens, cache use, and elapsed time. Provider charges, estimates,
and unknown costs remain distinct. DeepSeek offers no per-request invoice; reconcile
a campaign against the account balance read before and after it. The
[specification](SPEC.md) defines the record and accounting contracts;
[src/record.ts](src/record.ts) defines the shared `BenchRecord` shape.

Compare configurations from interleaved runs on the same tasks (the
[configuration matrix](swebench/README.md#configuration-matrix)): separate launches
of one commit drift enough to swamp most configuration effects.

Public reports and evidence bundles belong in this repository's
[GitHub releases](https://github.com/plurnk/plurnk-bench/releases), not in a separate
repository per campaign. Include the task selection, revisions, model route and
settings, limits, and accounting basis with each report. Publish verdicts, patches,
evaluator output and numeric request ledgers, never transcripts, wire captures or
databases: they can contain private data, and a native comparator's shell inherits
its provider credential, which a model can print. Before upload, search the bundle
for the value of every credential in the invoking environment without printing them.

## Development

```sh
npm test
```

This runs TypeScript checks, Python driver tests, and Node tests; it does not
launch a paid benchmark. Keep benchmark adaptation and reporting here;
product fixes belong in the [service](https://github.com/plurnk/plurnk-service)
or [client](https://github.com/plurnk/plurnk).

[Issues](https://github.com/plurnk/plurnk-bench/issues) and pull requests are welcome.

## License

[MIT](LICENSE).
