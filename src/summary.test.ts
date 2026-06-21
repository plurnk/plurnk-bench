import { test } from "node:test";
import assert from "node:assert/strict";
import Summary from "./summary.ts";
import type { BenchRecord, Outcome } from "./record.ts";

const record = (overrides: Partial<BenchRecord> = {}): BenchRecord => ({
    harness: "deepswe",
    taskId: "task-1",
    model: "gemma",
    startedAt: "2026-06-21T00:00:00.000Z",
    finishedAt: "2026-06-21T00:00:01.000Z",
    durationMs: 1000,
    status: 200,
    outcome: "pass",
    turns: 3,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    ...overrides,
});

test("empty summary reports zeros, not NaN", () => {
    const { total, passed, passRate, durationMs, totalTokens } = new Summary().report();
    assert.equal(total, 0);
    assert.equal(passed, 0);
    assert.equal(passRate, 0);
    assert.equal(durationMs.mean, 0);
    assert.equal(durationMs.p95, 0);
    assert.equal(totalTokens.total, 0);
});

test("counts outcomes and computes pass rate", () => {
    const outcomes: Outcome[] = ["pass", "pass", "fail", "error", "timeout"];
    const summary = new Summary().addAll(outcomes.map((outcome, i) => record({ taskId: `t${i}`, outcome })));
    const { total, passed, passRate, byOutcome } = summary.report();
    assert.equal(total, 5);
    assert.equal(passed, 2);
    assert.equal(passRate, 0.4);
    assert.deepEqual(byOutcome, { pass: 2, fail: 1, error: 1, timeout: 1, cancelled: 0 });
});

test("histograms plurnk terminal status separately from outcome", () => {
    const summary = new Summary()
        .add(record({ status: 200, outcome: "fail" }))   // loop ok, oracle rejected
        .add(record({ status: 500, outcome: "error" }))
        .add(record({ status: 200, outcome: "pass" }));
    const { byStatus } = summary.report();
    assert.deepEqual(byStatus, { "200": 2, "500": 1 });
});

test("quantiles use nearest-rank over duration and tokens", () => {
    const durations = [10, 20, 30, 40, 100];
    const summary = new Summary().addAll(
        durations.map((durationMs, i) => record({
            taskId: `d${i}`,
            durationMs,
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: durationMs },
        })),
    );
    const { durationMs, totalTokens } = summary.report();
    assert.equal(durationMs.total, 200);
    assert.equal(durationMs.mean, 40);
    assert.equal(durationMs.p50, 30);   // ceil(0.5*5)=3 → 3rd value
    assert.equal(durationMs.p95, 100);  // ceil(0.95*5)=5 → 5th value
    assert.equal(totalTokens.p50, 30);
});

test("size tracks accumulated records", () => {
    const summary = new Summary();
    assert.equal(summary.size, 0);
    summary.add(record());
    summary.add(record({ taskId: "task-2" }));
    assert.equal(summary.size, 2);
});
