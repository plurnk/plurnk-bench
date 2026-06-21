import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOutcome, joinRecord, type PlurnkDoc, type RewardJson } from "./ingest.ts";

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
