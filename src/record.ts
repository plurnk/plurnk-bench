// The canonical benchmark result record: one task attempt, end to end.
//
// Two orthogonal verdicts, never conflated:
//   - `status` is plurnk's own terminal — the loop's final SEND code (200 ok,
//     499 cancelled, 4xx/5xx failed). It says how the AGENT LOOP ended.
//   - `outcome` is the HARNESS's score — did the task's own oracle (DeepSWE: do
//     the repo's tests pass against the produced patch?) accept the result. A
//     loop can terminate 200 and still fail the benchmark's oracle, and vice
//     versa. The harness owns this column; the loop status never sets it.
//
// JSON Schema is the contract elsewhere in the ecosystem; here a record is a
// plain shape (no Zod, no class) so it serializes 1:1 to a store row / JSONL line.

export type Outcome = "pass" | "fail" | "error" | "timeout" | "cancelled";

export interface Usage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface BenchRecord {
    harness: string;        // which harness produced this — "deepswe"
    taskId: string;         // the benchmark's own task identifier
    model: string;          // PLURNK_MODEL under test
    startedAt: string;      // ISO 8601
    finishedAt: string;     // ISO 8601
    durationMs: number;     // wall-clock for the whole attempt
    status: number;         // plurnk terminal SEND status (loop verdict)
    outcome: Outcome;       // harness oracle verdict (benchmark verdict)
    turns: number;          // loop turns consumed
    usage: Usage;
    sessionId?: string;     // plurnk session id, for forensic drill-down
    runId?: string;         // plurnk run id, for forensic drill-down
    error?: string;         // failure detail when outcome is error/timeout
}
