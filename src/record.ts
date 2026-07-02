// The benchmark task attempt: one DeepSWE task driven through plurnk to a verdict.
//
// Shaped by the two real artifacts it joins (see ingest.ts): the loop side from the
// plurnk client's `--json` document (finalStatus, runId, turnCount, wallMs, usage —
// the daemon's own reported numbers, captured not re-summed), and the oracle side
// from Pier's verifier `reward.json`. This is the one concept the daemon DB + digest
// don't model; `run` is the drill-down handle back into digest.
//
// Two orthogonal verdicts, never conflated:
//   - `status`: plurnk's terminal SEND code — how the AGENT LOOP ended (200/499/4xx).
//   - `outcome`/`reward`/`testPassFraction`: the Pier verifier's score — how the
//     BENCHMARK graded the produced patch. A loop can end 200 and still fail the oracle.

export type Outcome = "pass" | "fail" | "error" | "timeout" | "cancelled";

// Token usage as the daemon reports it on the `--json` doc (authoritative snapshot).
export interface Usage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costPico?: number;          // daemon's cost estimate in pico-dollars, when priced
}

// Pointer into the daemon DB for `bin/digest.ts` forensics — bench NEVER reads the DB
// itself (digest owns DB→forensics). `dbPath` is the always-present handle: `digest
// <dbPath>` renders the run(s). session/runId come from the client's `--json` doc when
// the loop reported them (a crash/error doc drops them) and scope digest to one run.
export interface RunRef {
    dbPath: string;             // daemon DB path — always present when a DB was copied
    sessionId?: number;         // plurnk session id, from the --json doc — digest scope
    runId?: number;             // plurnk run id, from the --json doc — digest drill-down key
}

export interface BenchRecord {
    harness: string;            // which harness produced this — "deepswe"
    taskId: string;             // the benchmark's own task identifier
    model: string;              // model under test (PLURNK_MODEL alias / record label)
    durationMs: number;         // plurnk wallMs — agent-loop wall time
    status: number;             // plurnk terminal SEND status (loop verdict)
    outcome: Outcome;           // benchmark verdict — derived from the oracle / failure class
    reward?: number;            // Pier verifier binary reward (0 | 1)
    // Pier verifier `partial` — fraction of all tests passing in the graded patch.
    // ONLY meaningful once `outcome` says a loop ran (fail/pass): on error/timeout/
    // cancelled the committed diff is often empty, so this is the BASE repo's grade
    // (its pass-to-pass tests), not progress. Always read it gated on `outcome`.
    testPassFraction?: number;
    turns: number;              // plurnk turnCount — loop turns consumed
    usage?: Usage;              // daemon-reported tokens, if the doc carried them
    run?: RunRef;               // digest drill-down handle (absent if the run never started)
    startedAt?: string;         // ISO 8601, when available (Pier trial timing)
    finishedAt?: string;        // ISO 8601
    error?: string;             // failure detail when outcome is error/timeout
}
