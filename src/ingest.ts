// Join one Pier trial's two artifacts into a BenchRecord: the plurnk client's
// `--json` document (loop side) + Pier's verifier `reward.json` (oracle side).
//
// Shapes mirror the producers exactly:
//   - PlurnkDoc  ← plurnk/src/cli.ts buildJsonRecord (schemaVersion 1) / buildJsonError
//   - RewardJson ← deep-swe tests/grader.py reward.json
// The dir-walking glue (which trial dir, taskId/model provenance) firms up against a
// real Pier `jobs/` tree at smoke time; the JOIN below is the grounded, tested core.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
        // Base pass-to-pass tests all pass on the pristine repo, so any p2p failure means
        // the patch broke the build / existing behavior (the BROKE-THE-BUILD failure mode).
        if (reward.p2p_total !== undefined && reward.p2p_passed !== undefined && reward.p2p_passed < reward.p2p_total)
            record.p2pRegressed = true;
    }
    if (doc.session !== undefined && typeof doc.runId === "number") {
        record.run = { sessionId: doc.session.id, runId: doc.runId, dbPath };
    }
    if (doc.error !== undefined) record.error = `${doc.error.kind}: ${doc.error.message}`;
    return record;
};

// One Pier trial's result.json — the provenance + Pier-level lifecycle the loop doc
// can't carry (a build/timeout/cancel failure kills the trial before plurnk writes a
// doc). Subset of pier/trial/trial.py's TrialResult.
export interface PierTrialResult {
    task_name?: string;                                          // canonical benchmark task id
    trial_name?: string;                                         // present iff this is a trial dir
    config?: { agent?: { model_name?: string | null } };        // the operator's record label
    exception_info?: { exception_type?: string; exception_message?: string } | null;
    started_at?: string;
    finished_at?: string;
}

// Pier exception types that mean the budget ran out, not that the loop scored a fail.
const TIMEOUT_EXCEPTIONS = new Set(["AgentTimeoutError", "VerifierTimeoutError"]);

// The authoritative turn count. The client's `--json` doc reports `turnCount: 0` on
// abnormal termination (timeout / 500 / crash) even when turns really ran — only the DB
// is honest. A count(*), not forensics: digest still owns the DB→waterfall projection.
const dbTurnCount = (dbPath: string): number | null => {
    try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            return (db.prepare("SELECT count(*) AS c FROM turns").get() as { c: number }).c;
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
};

const readJson = <T>(path: string): T | null => {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return null;
    }
};

// Read one Pier trial directory's artifacts and join them. `reward.json` absent
// (verifier crash / disabled) joins as a null oracle → an `error` outcome. The digest
// handle is the DB POINTER, never a bench-side DB read — plurnk owns DB→forensics
// (digest). On a clean finish the loop doc carries session+runId and joinRecord scopes
// the handle to that run; on a crash/error doc the coordinate is absent but the driver
// still copied the DB, so we carry `dbPath` alone (digest renders the whole DB from it).
// No DB copied at all → no handle, honestly absent.
export const readTrial = (trialDir: string, meta: { harness: string; taskId: string; model: string }): BenchRecord => {
    const doc = readJson<PlurnkDoc>(join(trialDir, "agent", "plurnk.json"))
        ?? { schemaVersion: 0, error: { kind: "ingest", message: "plurnk.json missing" } };
    const reward = readJson<RewardJson>(join(trialDir, "verifier", "reward.json"));
    const dbPath = join(trialDir, "agent", "plurnk.db");
    const record = joinRecord({ ...meta, doc, reward, dbPath });
    if (existsSync(dbPath)) {
        if (record.run === undefined) record.run = { dbPath };
        const turns = dbTurnCount(dbPath);
        if (turns !== null) record.turns = turns;   // DB wins over the doc's abnormal-termination 0
    }
    // Did the model actually edit the repo? Pier extracts `git diff base..HEAD` here; an
    // empty patch = NO-ATTEMPT (the loop edited plurnk scratch, never `/app`).
    const patchPath = join(trialDir, "artifacts", "model.patch");
    if (existsSync(patchPath)) {
        const raw = readFileSync(patchPath, "utf8");
        record.patchLines = raw === "" ? 0 : raw.replace(/\n+$/, "").split("\n").length;
        // Existing files modified = total diffs minus new-file additions. A junk dump (a
        // weak model writing dir_tree.txt etc. into /app) is all new files → 0 modified →
        // still a no-attempt despite a non-empty patch.
        const files = (raw.match(/^diff --git /gm) ?? []).length;
        const newFiles = (raw.match(/^new file mode /gm) ?? []).length;
        record.filesModified = files - newFiles;
    }
    return record;
};

// Walk a Pier `jobs/<job>/` tree → one BenchRecord per trial. A trial dir is any
// child holding a result.json with a `trial_name` (the job-level result.json has
// none). result.json is the provenance source — task_name + model_name + Pier-level
// timing/exception; the artifact join (loop doc + oracle) delegates to readTrial.
// Trials are walked in directory-name order for deterministic output.
export const readJob = (jobDir: string, { harness }: { harness: string }): BenchRecord[] => {
    const dirs = readdirSync(jobDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .toSorted();
    const records: BenchRecord[] = [];
    for (const name of dirs) {
        const trialDir = join(jobDir, name);
        const result = readJson<PierTrialResult>(join(trialDir, "result.json"));
        if (result?.trial_name === undefined) continue;   // not a trial dir
        const record = readTrial(trialDir, {
            harness,
            taskId: result.task_name ?? name,
            model: result.config?.agent?.model_name ?? "unknown",
        });
        if (result.started_at !== undefined) record.startedAt = result.started_at;
        if (result.finished_at !== undefined) record.finishedAt = result.finished_at;
        // A Pier-level failure (build/timeout/cancel) the loop doc never saw: surface
        // it as the error detail and reclassify a timeout — but only when the join
        // didn't already land a verdict from a real loop doc (outcome still "error").
        const ex = result.exception_info;
        if (ex?.exception_type !== undefined && record.outcome === "error") {
            record.error = ex.exception_message
                ? `${ex.exception_type}: ${ex.exception_message}`
                : ex.exception_type;
            if (TIMEOUT_EXCEPTIONS.has(ex.exception_type)) record.outcome = "timeout";
        }
        records.push(record);
    }
    return records;
};
