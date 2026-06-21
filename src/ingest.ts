// Join one Pier trial's two artifacts into a BenchRecord: the plurnk client's
// `--json` document (loop side) + Pier's verifier `reward.json` (oracle side).
//
// Shapes mirror the producers exactly:
//   - PlurnkDoc  ← plurnk/src/cli.ts buildJsonRecord (schemaVersion 1) / buildJsonError
//   - RewardJson ← deep-swe tests/grader.py reward.json
// The dir-walking glue (which trial dir, taskId/model provenance) firms up against a
// real Pier `jobs/` tree at smoke time; the JOIN below is the grounded, tested core.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BenchRecord, Outcome, Usage } from "./record.ts";

// The subset of plurnk's `--json` document this join consumes. A failed one-shot
// emits `{ schemaVersion, error: { kind, message } }` instead of a full record.
export interface PlurnkDoc {
    schemaVersion: number;
    session?: { id: number; name: string };
    finalStatus?: number;
    timedOut?: boolean;
    runId?: number | null;
    turnCount?: number;
    wallMs?: number;
    usage?: { promptTokens: number; completionTokens: number; costPico: number } | null;
    error?: { kind: string; message: string };
}

// deep-swe grader output. `reward` is the binary verdict; `partial` the fraction of
// all (fail-to-pass + pass-to-pass) tests passing; `apply_failed` set if the patch
// didn't apply.
export interface RewardJson {
    reward: number;
    f2p_total?: number;
    f2p_passed?: number;
    p2p_total?: number;
    p2p_passed?: number;
    f2p?: number;
    p2p?: number;
    partial?: number;
    apply_failed?: number;
}

// The oracle is ground truth for PASS: reward===1 wins regardless of how the loop
// ended. A non-pass is then classified by the loop's own failure mode (client error
// doc → error, timed out → timeout, cancelled SEND[499] → cancelled, else fail).
export const deriveOutcome = (doc: PlurnkDoc, reward: RewardJson | null): Outcome => {
    if (reward?.reward === 1) return "pass";
    if (doc.error !== undefined) return "error";
    if (doc.timedOut === true) return "timeout";
    if (doc.finalStatus === 499) return "cancelled";
    if (reward === null) return "error";   // oracle never graded and the loop didn't pass
    return "fail";
};

const usageOf = (doc: PlurnkDoc): Usage | undefined => {
    if (doc.usage === undefined || doc.usage === null) return undefined;
    const { promptTokens, completionTokens, costPico } = doc.usage;
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, costPico };
};

export interface JoinInput {
    harness: string;
    taskId: string;
    model: string;
    doc: PlurnkDoc;
    reward: RewardJson | null;
    dbPath: string;
}

export const joinRecord = ({ harness, taskId, model, doc, reward, dbPath }: JoinInput): BenchRecord => {
    const record: BenchRecord = {
        harness,
        taskId,
        model,
        durationMs: doc.wallMs ?? 0,
        status: doc.finalStatus ?? 0,
        outcome: deriveOutcome(doc, reward),
        turns: doc.turnCount ?? 0,
    };
    const usage = usageOf(doc);
    if (usage !== undefined) record.usage = usage;
    if (reward !== null) {
        record.reward = reward.reward;
        if (reward.partial !== undefined) record.testPassFraction = reward.partial;
    }
    if (doc.session !== undefined && typeof doc.runId === "number") {
        record.run = { sessionId: doc.session.id, runId: doc.runId, dbPath };
    }
    if (doc.error !== undefined) record.error = `${doc.error.kind}: ${doc.error.message}`;
    return record;
};

const readJson = <T>(path: string): T | null => {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return null;
    }
};

// Read one Pier trial directory's artifacts and join them. `reward.json` absent
// (verifier crash / disabled) joins as a null oracle → an `error` outcome.
export const readTrial = (trialDir: string, meta: { harness: string; taskId: string; model: string }): BenchRecord => {
    const doc = readJson<PlurnkDoc>(join(trialDir, "agent", "plurnk.json"))
        ?? { schemaVersion: 0, error: { kind: "ingest", message: "plurnk.json missing" } };
    const reward = readJson<RewardJson>(join(trialDir, "verifier", "reward.json"));
    const dbPath = join(trialDir, "agent", "plurnk.db");
    return joinRecord({ ...meta, doc, reward, dbPath });
};
