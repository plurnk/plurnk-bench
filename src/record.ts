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

// Handle into the daemon DB that holds the run, for `bin/digest.ts` forensics.
export interface RunRef {
    sessionId: number;          // plurnk session id (DB row)
    runId: number;              // plurnk run id (DB row) — digest drill-down key
    dbPath: string;             // daemon DB path — `digest <dbPath>` reconstructs the run
}

export interface BenchRecord {
    harness: string;            // which harness produced this — "deepswe"
    taskId: string;             // the benchmark's own task identifier
    model: string;              // model under test (PLURNK_MODEL alias / record label)
    durationMs: number;         // plurnk wallMs — agent-loop wall time
    status: number;             // plurnk terminal SEND status (loop verdict)
    outcome: Outcome;           // benchmark verdict — derived from the oracle / failure class
    reward?: number;            // Pier verifier binary reward (0 | 1)
    testPassFraction?: number;  // Pier verifier `partial` (held-out tests passing)
    turns: number;              // plurnk turnCount — loop turns consumed
    usage?: Usage;              // daemon-reported tokens, if the doc carried them
    run?: RunRef;               // digest drill-down handle (absent if the run never started)
    startedAt?: string;         // ISO 8601, when available (Pier trial timing)
    finishedAt?: string;        // ISO 8601
    error?: string;             // failure detail when outcome is error/timeout
}
