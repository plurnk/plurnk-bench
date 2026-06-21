// The benchmark task attempt: one DeepSWE task driven through plurnk to a verdict.
//
// This is the ONE concept the daemon's DB + bin/digest.ts do NOT model: it binds a
// benchmark task to the plurnk run that attempted it and to the benchmark oracle's
// score. Forensics are not reimplemented here — `run` is the drill-down handle into
// the service's existing digest (`digest <dbPath>`); token/cost rollups live in that
// DB, never re-summed in JS. (Provisional shape — id types + oracle fields firm up
// once the Pier driver contract and the client's programmatic run API land.)
//
// Two orthogonal verdicts, never conflated:
//   - `status`: plurnk's terminal SEND code — how the AGENT LOOP ended (200/499/4xx).
//   - `outcome`/`reward`/`testPassFraction`: the Pier verifier's score — how the
//     BENCHMARK graded the produced patch. A loop can end 200 and still fail the oracle.

export type Outcome = "pass" | "fail" | "error" | "timeout" | "cancelled";

// Handle into the daemon DB that holds the run, for `bin/digest.ts` forensics.
export interface RunRef {
    sessionId: number;          // plurnk session id (DB row)
    runId: number;              // plurnk run id (DB row) — digest drill-down key
    dbPath: string;             // daemon DB path — `digest <dbPath>` reconstructs the run
}

export interface BenchRecord {
    harness: string;            // which harness produced this — "deepswe"
    taskId: string;             // the benchmark's own task identifier
    model: string;              // PLURNK_MODEL under test
    startedAt: string;          // ISO 8601
    finishedAt: string;         // ISO 8601
    durationMs: number;         // wall-clock for the whole attempt
    status: number;             // plurnk terminal SEND status (loop verdict)
    outcome: Outcome;           // benchmark verdict — "pass" iff the oracle accepted
    reward?: number;            // Pier verifier binary reward (0 | 1)
    testPassFraction?: number;  // Pier verifier fraction of held-out tests passing
    turns: number;              // loop turns consumed
    run?: RunRef;               // digest drill-down handle (absent if the run never started)
    error?: string;             // failure detail when outcome is error/timeout
}
