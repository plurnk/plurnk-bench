import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveOutcome, joinRecord, readJob, readTrial, type PlurnkDoc, type RewardJson } from "./ingest.ts";

const doc = (overrides: Partial<PlurnkDoc> = {}): PlurnkDoc => ({
    schemaVersion: 1,
    session: { id: 1, name: "s" },
    finalStatus: 200,
    timedOut: false,
    runId: 7,
    turnCount: 9,
    wallMs: 4200,
    usage: { promptTokens: 800, completionTokens: 200, costPico: 0 },
    ...overrides,
});

const reward = (r: number, extra: Partial<RewardJson> = {}): RewardJson => ({ reward: r, partial: r, ...extra });

// The oracle is ground truth for PASS — reward===1 wins over any loop ending.
test("reward 1 is pass even when the loop was cancelled (499)", () => {
    assert.equal(deriveOutcome(doc({ finalStatus: 499 }), reward(1)), "pass");
});

test("non-pass is classified by the loop's failure mode", () => {
    assert.equal(deriveOutcome(doc({ error: { kind: "client:rpc", message: "x" } }), null), "error");
    assert.equal(deriveOutcome(doc({ timedOut: true }), reward(0)), "timeout");
    assert.equal(deriveOutcome(doc({ finalStatus: 499 }), reward(0)), "cancelled");
    assert.equal(deriveOutcome(doc(), null), "error");          // oracle never graded, no pass
    assert.equal(deriveOutcome(doc(), reward(0)), "fail");       // graded, not solved
});

test("joinRecord maps loop side from the plurnk doc, oracle side from reward", () => {
    const record = joinRecord({
        harness: "deepswe", taskId: "abs-module-cache-flags", model: "gemma",
        doc: doc(), reward: reward(1, { partial: 0.83 }), dbPath: "/jobs/t1/agent/plurnk.db",
    });
    assert.equal(record.status, 200);            // finalStatus (loop verdict)
    assert.equal(record.outcome, "pass");        // oracle verdict
    assert.equal(record.reward, 1);
    assert.equal(record.testPassFraction, 0.83);
    assert.equal(record.turns, 9);
    assert.equal(record.durationMs, 4200);
    assert.deepEqual(record.usage, { promptTokens: 800, completionTokens: 200, totalTokens: 1000, costPico: 0 });
    assert.deepEqual(record.run, { sessionId: 1, runId: 7, dbPath: "/jobs/t1/agent/plurnk.db" });
});

// A crashed loop emits an error doc with no session/runId, but the driver still copied
// the daemon DB. Bench does NOT read that DB (digest owns DB→forensics) — it carries
// the dbPath alone as the digest handle so the whole DB stays renderable.
test("readTrial carries a dbPath-only digest handle when the doc dropped the coordinate", () => {
    const trialDir = mkdtempSync(join(tmpdir(), "bench-trial-"));
    try {
        mkdirSync(join(trialDir, "agent"), { recursive: true });
        writeFileSync(join(trialDir, "agent", "plurnk.json"), JSON.stringify({
            schemaVersion: 1, error: { kind: "runtime_error", message: "undefined.length" },
        }));
        const dbPath = join(trialDir, "agent", "plurnk.db");
        writeFileSync(dbPath, "");   // the copied DB exists; bench never opens it
        const record = readTrial(trialDir, { harness: "deepswe", taskId: "t", model: "m" });
        assert.equal(record.outcome, "error");
        assert.deepEqual(record.run, { dbPath });   // pointer only — no coordinate reconstructed
    } finally {
        rmSync(trialDir, { recursive: true, force: true });
    }
});

// No DB copied (daemon never started) → no handle, honestly absent.
test("readTrial leaves no handle when no DB was copied", () => {
    const trialDir = mkdtempSync(join(tmpdir(), "bench-nodb-"));
    try {
        mkdirSync(join(trialDir, "agent"), { recursive: true });
        writeFileSync(join(trialDir, "agent", "plurnk.json"), "");
        const record = readTrial(trialDir, { harness: "deepswe", taskId: "t", model: "m" });
        assert.equal(record.run, undefined);
    } finally {
        rmSync(trialDir, { recursive: true, force: true });
    }
});

// readJob walks a real Pier `jobs/<job>/` tree: provenance from each trial's
// result.json, the artifact join from agent/+verifier/, deterministic dir order.
test("readJob walks a job tree → one record per trial, provenance from result.json", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-job-"));
    try {
        // A passing trial: full loop doc + reward 1.
        const pass = join(root, "foo__aaa");
        mkdirSync(join(pass, "agent"), { recursive: true });
        mkdirSync(join(pass, "verifier"), { recursive: true });
        writeFileSync(join(pass, "result.json"), JSON.stringify({
            trial_name: "foo__aaa", task_name: "datacurve/foo",
            config: { agent: { model_name: "plurnk/turboderp" } },
            started_at: "2026-06-30T01:00:00Z", finished_at: "2026-06-30T01:05:00Z",
        }));
        writeFileSync(join(pass, "agent", "plurnk.json"), JSON.stringify({
            schemaVersion: 1, session: { id: 1, name: "s" }, finalStatus: 200,
            runId: 7, turnCount: 3, wallMs: 1000, usage: null,
        }));
        writeFileSync(join(pass, "verifier", "reward.json"), JSON.stringify({ reward: 1, partial: 1 }));

        // A Pier-cancelled trial: empty loop doc, no reward, exception in result.json.
        const killed = join(root, "bar__bbb");
        mkdirSync(join(killed, "agent"), { recursive: true });
        writeFileSync(join(killed, "result.json"), JSON.stringify({
            trial_name: "bar__bbb", task_name: "datacurve/bar",
            config: { agent: { model_name: "plurnk/turboderp" } },
            exception_info: { exception_type: "AgentTimeoutError", exception_message: "1800s" },
            started_at: "2026-06-30T02:00:00Z", finished_at: "2026-06-30T02:30:00Z",
        }));
        writeFileSync(join(killed, "agent", "plurnk.json"), "");   // killed before the client wrote

        // Non-trial noise: the job-level result.json (no trial_name) + a stray file.
        writeFileSync(join(root, "result.json"), JSON.stringify({ n_total_trials: 2 }));
        writeFileSync(join(root, "job.log"), "noise");

        const records = readJob(root, { harness: "deepswe" });
        assert.equal(records.length, 2);

        // Deterministic dir-name order: bar__bbb before foo__aaa.
        const [bar, foo] = records;
        assert.equal(bar.taskId, "datacurve/bar");
        assert.equal(bar.model, "plurnk/turboderp");
        assert.equal(bar.outcome, "timeout");                       // AgentTimeoutError reclassified
        assert.equal(bar.error, "AgentTimeoutError: 1800s");        // Pier exception surfaced
        assert.equal(bar.startedAt, "2026-06-30T02:00:00Z");
        assert.equal(bar.run, undefined);                           // empty doc → no digest handle

        assert.equal(foo.taskId, "datacurve/foo");
        assert.equal(foo.outcome, "pass");
        assert.deepEqual(foo.run, { sessionId: 1, runId: 7, dbPath: join(pass, "agent", "plurnk.db") });
        assert.equal(foo.finishedAt, "2026-06-30T01:05:00Z");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a client error doc yields an error record with no run handle", () => {
    const record = joinRecord({
        harness: "deepswe", taskId: "t", model: "gemma",
        doc: { schemaVersion: 1, error: { kind: "client:connection", message: "refused" } },
        reward: null, dbPath: "/jobs/t/agent/plurnk.db",
    });
    assert.equal(record.outcome, "error");
    assert.equal(record.error, "client:connection: refused");
    assert.equal(record.run, undefined);         // no session/runId → no digest handle
    assert.equal(record.status, 0);              // no finalStatus in an error doc
});
