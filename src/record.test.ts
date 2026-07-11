import { test } from "node:test";
import assert from "node:assert/strict";
import type { BenchRecord } from "./record.ts";

const sample = (overrides: Partial<BenchRecord> = {}): BenchRecord => ({
    harness: "deepswe",
    taskId: "ts-go-001",
    model: "gemma",
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:05:00.000Z",
    durationMs: 300000,
    status: 200,
    outcome: "pass",
    reward: 1,
    testPassFraction: 1,
    turns: 12,
    run: { sessionId: 1, runId: 1, dbPath: "/tmp/plurnk-task.db" },
    ...overrides,
});

// The record's documented contract: it serializes 1:1 to a store row / JSONL line.
test("[§record-serial] BenchRecord round-trips through JSON without loss", () => {
    const record = sample();
    const restored = JSON.parse(JSON.stringify(record)) as BenchRecord;
    assert.deepEqual(restored, record);
});

// Loop verdict and oracle verdict are independent columns: a clean 200 loop can
// still fail the benchmark oracle. The record must be able to express that.
test("[§verdicts] status (loop verdict) is independent of outcome (oracle verdict)", () => {
    const record = sample({ status: 200, outcome: "fail", reward: 0, testPassFraction: 0.4 });
    assert.equal(record.status, 200);
    assert.equal(record.outcome, "fail");
    assert.equal(record.reward, 0);
});

// The forensic handle survives serialization — a skeptic reads dbPath+runId off a
// stored record and runs `digest <dbPath>` to reconstruct the exact run.
test("[§digest-boundary] digest drill-down handle is preserved", () => {
    const restored = JSON.parse(JSON.stringify(sample())) as BenchRecord;
    assert.deepEqual(restored.run, { sessionId: 1, runId: 1, dbPath: "/tmp/plurnk-task.db" });
});
