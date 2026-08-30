// Join one Pier trial's two artifacts into a BenchRecord: the plurnk client's
// `--json` document (loop side) + Pier's verifier `reward.json` (oracle side).
//
// Shapes mirror the producers exactly:
//   - PlurnkDoc  <- plurnk/src/cli.ts buildJsonRecord (schemaVersion 6) / buildJsonError
//   - RewardJson ← deep-swe tests/grader.py reward.json
// The dir-walking glue (which trial dir, taskId/model provenance) firms up against a
// real Pier `jobs/` tree at smoke time; the JOIN below is the grounded, tested core.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { BenchRecord, Outcome, Usage } from "./record.ts";
import { assertProviderAccountingProjection } from "./accounting.ts";
import type { WebMaterializationProvenance } from "./web-materialization.ts";
import {
    Problems,
    Validator,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";

// The subset of plurnk's `--json` document this join consumes. A failed one-shot
// emits `{ schemaVersion, problem: ProblemDetails }` instead of a full record.
export interface PlurnkDoc {
    schemaVersion: 6;
    workspace?: { id: number; name: string };
    finalStatus?: number;
    timedOut?: boolean;
    loopId?: number | null;
    workerId?: number | null;
    turnCount?: number;
    turns?: unknown[];
    wallMs?: number;
    usage?: Usage | null;
    problem?: ProblemDetails;
}

const assertPlurnkDoc = (doc: PlurnkDoc): PlurnkDoc => {
    if (doc.schemaVersion !== 6) {
        throw new Error(`unsupported plurnk client JSON schema ${String(doc.schemaVersion)}; expected 6`);
    }
    if ("error" in doc) {
        throw new Error("legacy plurnk client error field is not supported; use problem");
    }
    if (doc.usage !== undefined && doc.usage !== null) {
        assertProviderAccountingProjection(
            doc.usage.accounting,
            "plurnk client usage.accounting",
        );
        for (const [name, value] of [
            ["curationWeight", doc.usage.curationWeight],
            ["curationBudget", doc.usage.curationBudget],
            ["contextTokens", doc.usage.contextTokens],
            ["contextCapacity", doc.usage.contextCapacity],
        ] as const) {
            if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
                throw new TypeError(`plurnk client usage.${name} must be a non-negative safe integer or null`);
            }
        }
        if (typeof doc.usage.meta !== "object" || doc.usage.meta === null || Array.isArray(doc.usage.meta)) {
            throw new TypeError("plurnk client usage.meta must be an object");
        }
    }
    if (doc.finalStatus === undefined) {
        if (doc.problem !== undefined) Validator.assertProblemDetails(doc.problem);
    } else {
        Validator.assertOperationResult({
            status: doc.finalStatus,
            ...(doc.problem === undefined ? {} : { problem: doc.problem }),
        });
    }
    return doc;
};

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

// SPEC §verdicts-oracle-outranks / §verdicts-failure-class. The oracle is ground truth
// for PASS: reward===1 wins regardless of how the loop
// ended. A non-pass is then classified by the loop's own failure mode (client error
// doc → error, timed out → timeout, final status 499 → cancelled, else fail).
export const deriveOutcome = (doc: PlurnkDoc, reward: RewardJson | null): Outcome => {
    if (reward?.reward === 1) return "pass";
    if (doc.problem !== undefined && doc.finalStatus === undefined) return "error";
    if (doc.timedOut === true) return "timeout";
    if (doc.finalStatus === 499) return "cancelled";
    if (reward === null) return "error";   // oracle never graded and the loop didn't pass
    return "fail";
};

const usageOf = (doc: PlurnkDoc): Usage | undefined => {
    if (doc.usage === undefined || doc.usage === null) return undefined;
    return doc.usage;
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
    assertPlurnkDoc(doc);
    const record: BenchRecord = {
        harness,
        taskId,
        model,
        durationMs: doc.wallMs ?? 0,
        status: doc.finalStatus ?? doc.problem?.status ?? 0,
        outcome: deriveOutcome(doc, reward),
        // SPEC §turns-provenance: the doc's own turns[] array is honest even when turnCount lies (0) on abnormal
        // termination; fall back to turnCount, then 0. No raw-DB read — SqlRite owns the DB.
        turns: doc.turns?.length ?? doc.turnCount ?? 0,
    };
    const usage = usageOf(doc);
    if (usage !== undefined) record.usage = usage;
    if (reward !== null) {
        record.reward = reward.reward;
        if (reward.partial !== undefined) record.testPassFraction = reward.partial;
        // Base pass-to-pass tests all pass on the pristine repo, so any p2p failure means
        // the patch broke the build / existing behavior (the BROKE-THE-BUILD failure mode).
        // A run whose p2p suite was counted states `false` outright; only an uncounted suite
        // leaves the field absent, so "not regressed" and "not measured" never share a spelling.
        if (reward.p2p_total !== undefined && reward.p2p_passed !== undefined)
            record.p2pRegressed = reward.p2p_passed < reward.p2p_total;
    }
    if (doc.workspace !== undefined && typeof doc.workerId === "number") {
        record.run = {
            workspaceId: doc.workspace.id,
            workerId: doc.workerId,
            ...(typeof doc.loopId === "number" ? { loopId: doc.loopId } : {}),
            dbPath,
        };
    }
    const problem = doc.problem;
    if (problem !== undefined) {
        record.problem = problem;
    }
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

const problemCode = (value: string): string => value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "unknown-exception";

const readJson = <T>(path: string): T | null => {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch {
        return null;
    }
};

interface BenchProvenanceArtifact {
    schemaVersion: 1;
    webMaterialization: WebMaterializationProvenance;
}

const exactKeys = (value: object, expected: string[]): boolean => {
    const actual = Object.keys(value).sort();
    const expectedSorted = expected.toSorted();
    return actual.length === expected.length
        && actual.every((key, index) => key === expectedSorted[index]);
};

const readWebMaterialization = (path: string): WebMaterializationProvenance | undefined => {
    if (!existsSync(path)) return undefined;

    const artifact = readJson<BenchProvenanceArtifact>(path);
    if (
        artifact === null
        || typeof artifact !== "object"
        || !exactKeys(artifact, ["schemaVersion", "webMaterialization"])
        || artifact.schemaVersion !== 1
        || typeof artifact.webMaterialization !== "object"
        || artifact.webMaterialization === null
        || !exactKeys(artifact.webMaterialization, ["tavily"])
        || typeof artifact.webMaterialization.tavily !== "object"
        || artifact.webMaterialization.tavily === null
        || !exactKeys(artifact.webMaterialization.tavily, ["configured", "depth"])
        || typeof artifact.webMaterialization.tavily.configured !== "boolean"
        || !["basic", "advanced"].includes(artifact.webMaterialization.tavily.depth)
    ) {
        throw new Error(`invalid bench provenance artifact: ${path}`);
    }
    return artifact.webMaterialization;
};

const countPatchLines = (raw: string): number => {
    if (raw === "") return 0;

    let binaryPayload = false;
    let lines = 0;
    for (const line of raw.replace(/\n+$/, "").split("\n")) {
        if (line.startsWith("diff --git ")) binaryPayload = false;
        if (binaryPayload) continue;

        lines++;
        if (line === "GIT binary patch") binaryPayload = true;
    }
    return lines;
};

// Harbor's text reward convention (`verifier/reward.txt`: "1.0" | "0" | "0.0") — the
// Enterprise-Bench judge writes only this and its `judge_result.json`. A binary oracle:
// one means PASS, anything else is a fail; unreadable text is an absent oracle.
const readRewardText = (path: string): RewardJson | null => {
    if (!existsSync(path)) return null;
    const value = Number(readFileSync(path, "utf8").trim());
    if (!Number.isFinite(value)) return null;
    return { reward: value >= 1 ? 1 : 0 };
};

// Read one Pier trial directory's artifacts and join them. `reward.json` absent
// (verifier crash / disabled) joins as a null oracle → an `error` outcome. The digest
// handle is the DB POINTER, never a bench-side DB read - plurnk owns DB->forensics
// (digest). On a clean finish the loop doc carries workspace+worker identity and joinRecord scopes
// the handle to that run; on a crash/error doc the coordinate is absent but the driver
// still copied the DB, so we carry `dbPath` alone (digest renders the whole DB from it).
// No DB copied at all → no handle, honestly absent.
export const readTrial = (trialDir: string, meta: { harness: string; taskId: string; model: string }): BenchRecord => {
    const doc = readJson<PlurnkDoc>(join(trialDir, "agent", "plurnk.json"))
        ?? {
            schemaVersion: 6,
            problem: Problems.create(
                "bench:ingest",
                "client-record-missing",
                500,
                "The trial did not produce agent/plurnk.json.",
                { stage: "ingest", retryable: false },
            ),
        };
    const reward = readJson<RewardJson>(join(trialDir, "verifier", "reward.json"))
        ?? readRewardText(join(trialDir, "verifier", "reward.txt"));
    const dbPath = join(trialDir, "agent", "plurnk.db");
    const record = joinRecord({ ...meta, doc, reward, dbPath });
    const webMaterialization = readWebMaterialization(join(trialDir, "agent", "plurnk-bench.json"));
    if (webMaterialization !== undefined) record.webMaterialization = webMaterialization;
    // Carry the DB pointer as the digest handle when the loop doc dropped the coordinate.
    if (existsSync(dbPath) && record.run === undefined) record.run = { dbPath };
    // SPEC §attempt-telemetry. Did the model actually edit the repo? Pier extracts `git diff base..HEAD` here; an
    // empty patch = NO-ATTEMPT (the loop edited plurnk scratch, never `/app`).
    const patchPath = join(trialDir, "artifacts", "model.patch");
    if (existsSync(patchPath)) {
        const raw = readFileSync(patchPath, "utf8");
        record.patchLines = countPatchLines(raw);
        // Existing files modified = total diffs minus new-file additions. A junk dump (a
        // weak model writing dir_tree.txt etc. into /app) is all new files → 0 modified →
        // still a no-attempt despite a non-empty patch.
        const files = (raw.match(/^diff --git /gm) ?? []).length;
        const newFiles = (raw.match(/^new file mode /gm) ?? []).length;
        record.filesModified = files - newFiles;
    }
    return record;
};

// SPEC §provenance. Walk a Pier `jobs/<job>/` tree → one BenchRecord per trial. A trial dir is any
// child holding a result.json with a `trial_name` (the job-level result.json has
// none). result.json is the provenance source — task_name + model_name + Pier-level
// timing/exception; the artifact join (loop doc + oracle) delegates to readTrial.
// Trials are walked in directory-name order for deterministic output.
// A trial dir is any directory holding a result.json with a `trial_name` (the job-level
// result.json has none). Present only once the harness has finished the trial.
export const isTrialDir = (dir: string): boolean =>
    readJson<PierTrialResult>(join(dir, "result.json"))?.trial_name !== undefined;

// SPEC §provenance. One trial dir → one BenchRecord, or null when it is not a trial dir.
// result.json is the provenance source — task_name + model_name + harness-level
// timing/exception; the artifact join (loop doc + oracle) delegates to readTrial.
export const readTrialDir = (trialDir: string, { harness }: { harness: string }): BenchRecord | null => {
    const result = readJson<PierTrialResult>(join(trialDir, "result.json"));
    if (result?.trial_name === undefined) return null;   // not a trial dir
    const record = readTrial(trialDir, {
        harness,
        taskId: result.task_name ?? basename(trialDir),
        model: result.config?.agent?.model_name ?? "unknown",
    });
    if (result.started_at !== undefined) record.startedAt = result.started_at;
    if (result.finished_at !== undefined) record.finishedAt = result.finished_at;
    // A Pier-level failure (build/timeout/cancel) the loop doc never saw: map
    // the external exception once and reclassify a timeout - but only when the join
    // didn't already land a verdict from a real loop doc (outcome still "error").
    const ex = result.exception_info;
    if (ex?.exception_type !== undefined && record.outcome === "error") {
        const detail = ex.exception_message
            ? `${ex.exception_type}: ${ex.exception_message}`
            : ex.exception_type;
        const timedOut = TIMEOUT_EXCEPTIONS.has(ex.exception_type);
        record.problem = Problems.create(
            "bench:pier",
            problemCode(ex.exception_type),
            timedOut ? 504 : 500,
            detail,
            {
                stage: "trial",
                upstreamType: ex.exception_type,
                retryable: false,
            },
        );
        record.status = record.problem.status;
        if (timedOut) record.outcome = "timeout";
    }
    return record;
};

// SPEC §provenance. Walk a `jobs/<harness>/<job>/` tree → one BenchRecord per trial, in
// directory-name order for deterministic output.
export const readJob = (jobDir: string, { harness }: { harness: string }): BenchRecord[] =>
    readdirSync(jobDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => readTrialDir(join(jobDir, e.name), { harness }))
        .filter((record): record is BenchRecord => record !== null);
