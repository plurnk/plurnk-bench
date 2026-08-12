// The benchmark task attempt: one DeepSWE task driven through plurnk to a verdict.
//
// Shaped by the two real artifacts it joins (see ingest.ts): the loop side from the
// plurnk client's `--json` document (finalStatus, loopId, turnCount, wallMs, usage -
// the daemon's own reported numbers, captured not re-summed), and the oracle side
// from Pier's verifier `reward.json`. This is the one concept the daemon DB + digest
// don't model; `run` is the drill-down handle back into digest.
//
// Two orthogonal verdicts (SPEC §verdicts), never conflated:
//   - `status`: plurnk's terminal SEND code — how the AGENT LOOP ended (200/499/4xx).
//   - `outcome`/`reward`/`testPassFraction`: the Pier verifier's score — how the
//     BENCHMARK graded the produced patch. A loop can end 200 and still fail the oracle.

import type { WebMaterializationProvenance } from "./web-materialization.ts";
import type {
    ProviderAccountingProjection,
} from "./accounting.ts";

export type Outcome = "pass" | "fail" | "error" | "timeout" | "cancelled";

// The complete loop usage envelope from the client document. Physical requests
// remain the source evidence; aggregate usage and exact-decimal USD are preserved
// verbatim rather than projected into a bench-owned accounting representation.
export interface Usage {
    accounting: ProviderAccountingProjection;
    contextTokens: number | null;
    promptBudget: number | null;
    meta: Record<string, unknown>;
}

// Pointer into the daemon DB (SPEC §digest-boundary) — bench NEVER reads the DB
// itself (digest owns DB→forensics). `dbPath` is the always-present handle: `digest
// <dbPath>` renders the run(s). Workspace, worker, and loop identity come from
// the client's `--json` doc when
// the loop reported them (a crash/error doc drops them) and scope digest to one run.
export interface RunRef {
    dbPath: string;             // daemon DB path — always present when a DB was copied
    workspaceId?: number;       // workspace scope for digest
    workerId?: number;          // conversation worker scope for digest
    loopId?: number;            // terminal loop identity for correlation
}

export interface BenchRecord {
    harness: string;            // which harness produced this — "deepswe"
    taskId: string;             // the benchmark's own task identifier
    model: string;              // model under test (PLURNK_MODEL alias / record label)
    durationMs: number;         // plurnk wallMs — agent-loop wall time
    status: number;             // plurnk terminal SEND status (loop verdict)
    outcome: Outcome;           // benchmark verdict — derived from the oracle / failure class
    reward?: number;            // Pier verifier binary reward (0 | 1)
    // Pier verifier `partial` — fraction of all tests passing (SPEC §attempt-partial-gated).
    // ONLY meaningful once `outcome` says a loop ran (fail/pass): on error/timeout/
    // cancelled the committed diff is often empty, so this is the BASE repo's grade
    // (its pass-to-pass tests), not progress. Always read it gated on `outcome`.
    testPassFraction?: number;
    // Failure-mode telemetry (SPEC §attempt-telemetry) — makes a 0-reward legible without opening the patch:
    //   filesModified 0           → NO-ATTEMPT (no existing source touched — even if the patch
    //                               is non-empty, e.g. a weak model dumping junk .txt into /app)
    //   filesModified>0 + regress → BROKE-THE-BUILD (real source edit, broke existing / didn't compile)
    //   filesModified>0, no regress, testPassFraction<1 → NEAR-MISS / FAIL
    patchLines?: number;        // textual lines in the graded patch; excludes Git's encoded binary payload
    filesModified?: number;     // EXISTING files the patch changes (excludes new-file additions) — the
                                // real "did it edit the source?" signal; 0 = no genuine repo attempt
    p2pRegressed?: boolean;     // a base pass-to-pass test now fails — the patch broke build/existing behavior
    turns: number;              // plurnk turnCount — loop turns consumed
    usage?: Usage;              // daemon-reported tokens, if the doc carried them
    run?: RunRef;               // digest drill-down handle (absent if the run never started)
    startedAt?: string;         // ISO 8601, when available (Pier trial timing)
    finishedAt?: string;        // ISO 8601
    webMaterialization?: WebMaterializationProvenance;
    problem?: import("@plurnk/plurnk-contracts").ProblemDetails; // exact client or terminal failure occurrence
}
