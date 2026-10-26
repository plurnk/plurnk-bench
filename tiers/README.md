# Live & Demo Specimen Tiers

Run the paid real-model `live` and `demo` specimen corpora against a candidate
service and client checkout. Each specimen drives one or more real model loops
through the platform's public harness surface (`@plurnk/plurnk-service/harness`)
and retains a complete session database, digest, and `BenchRecord` under the
benchmarks home.

Run commands from the repository root after the [shared setup](../README.md#setup).

## Prerequisites

Select clean, installed candidate checkouts (or a frozen pair prepared by
`deepswe/relock.sh`) and an explicit model alias from
`${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env`:

```sh
export PLURNK_BENCHLET_SERVICE_ROOT=/path/to/plurnk-service
export PLURNK_BENCHLET_CLIENT_ROOT=/path/to/plurnk
export PLURNK_MODEL="your-model-alias"
```

## Run a tier or single specimen

```sh
npm run tier:live -- --specimen "live: bare completion"
npm run tier:demo -- --specimen "demo: one-entry loop reads and completes"
npm run tier:live
npm run tier:demo
```

Repeat `--specimen <exact-test-name>` to run a subset; passing an unknown
specimen name refuses before invoking a model and lists the available names.
Running without `--specimen` executes the full tier and can incur substantial
inference cost.

## Retained evidence

Each invocation allocates `<benchmarksHome>/tier-<live|demo>-<stamp>/` containing:

| Artifact | Purpose |
|---|---|
| `provenance.json` | Candidate `bench`, `service`, and `client` git revisions, selected model alias, tier, and selected specimens. |
| `census.md` / `census.json` | Per-specimen verdict table and session ledger (`loops`, `turns`, `requests`, `runDir`). |
| `result.json` | Joined tier summary (`passed`, `failed`, `errors`, `ungraded`, and `recordedCost` from `summarizeRecords`). |
| `<label>-<id>/` | Per-session `plurnk.db`, `digest/`, `session.json`, and `record.json` (`BenchRecord`). |
