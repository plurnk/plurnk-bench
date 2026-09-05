import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportJob, summarizeTasks } from "./report.ts";
import type { TaskReport } from "./report.ts";

const task = (name: string, reward: number | null, costUsd: string | null): TaskReport => ({
    task: name, reward, outcome: reward === 1 ? "pass" : "fail", durationMs: 60_000,
    evidence: "/fixture", accounting: {
        providerRequests: 2, rejectedEmissions: 1, models: ["model"], costUsd,
        usage: { inputTokens: 100, outputTokens: 10, inputTokenDetails: { cacheReadTokens: 80 } },
        cacheEffectiveness: { inputTokens: 100, cacheReadTokens: 80, cacheReadTokenRatio: 0.8 },
    },
    costEvidence: { charged: 0, estimated: 2, unknown: 0 },
});

test("{§deepswe-report} task-weighted medians include failures and retain cost authority", () => {
    const result = summarizeTasks([task("a", 1, "1"), task("b", 0, "3"), task("c", 1, "0.5")]);
    assert.equal(result.passed, 2);
    assert.equal(result.graded, 3);
    assert.equal(result.metrics.passRate, 2 / 3);
    assert.deepEqual(result.metrics.medianCostPerSuccessfulTaskUsd, { value: 0.75, reported: 2, eligible: 2 });
    assert.deepEqual(result.metrics.medianCostPerTaskUsd, { value: 1, reported: 3, eligible: 3 });
    assert.deepEqual(result.metrics.medianCacheHitRatePerSuccessfulTask, { value: 0.8, reported: 2, eligible: 2 });
    assert.deepEqual(result.metrics.medianTimePerSuccessfulTaskMs, { value: 60_000, reported: 2, eligible: 2 });
    assert.deepEqual(result.costEvidence, { charged: 0, estimated: 6, unknown: 0 });
    assert.deepEqual(result.recordedCost, { totalUsd: "4.5", reported: 3, eligible: 3 });
});

test("{§deepswe-report} unknown accounting and absent rewards are not zero-cost failures", () => {
    const incomplete = { ...task("incomplete", null, null), accounting: null, costEvidence: null };
    const result = summarizeTasks([task("pass", 1, null), incomplete]);
    assert.equal(result.passed, 1);
    assert.equal(result.graded, 1);
    assert.equal(result.ungraded, 1);
    assert.deepEqual(result.metrics.medianCostPerSuccessfulTaskUsd, { value: null, reported: 0, eligible: 1 });
    assert.deepEqual(result.recordedCost, { totalUsd: null, reported: 0, eligible: 2 });
    assert.equal(result.accountingCoverage.reported, 1);
    assert.throws(() => summarizeTasks([task("same", 1, "0"), task("same", 0, "0")]), /duplicate task/);
});

test("{§deepswe-report} saved-job reporting reads the workspace digest, not parent-only client totals", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bench-report-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
    const trial = join(root, "task__abc");
    const published = join(root, "published");
    mkdirSync(join(trial, "agent"), { recursive: true });
    mkdirSync(join(trial, "verifier"));
    mkdirSync(join(published, "digest"), { recursive: true });
    write(join(root, "result.json"), { n_total_trials: 113, stats: { n_completed_trials: 1, evals: {} } });
    write(join(trial, "result.json"), { trial_name: "task__abc", task_name: "task" });
    write(join(trial, "agent", "plurnk.json"), { schemaVersion: 6, finalStatus: 200, wallMs: 5000 });
    write(join(trial, "verifier", "reward.json"), { reward: 1 });
    writeFileSync(join(trial, ".plurnk-bench-published"), published);
    const requests = ["parent", "child"].map((model) => ({
        model, cost: { kind: "estimated" },
        usage: { inputTokens: 50, inputTokenDetails: { cacheReadTokens: 45 } },
    }));
    write(join(published, "digest", "digest.json"), {
        workspaces: [{ accounting: { requests, costUsd: "0.3", usage: { inputTokens: 100, inputTokenDetails: { cacheReadTokens: 90 } } } }],
        provider_requests: requests.map((accounting) => ({ kind: "emission", accounting })), turn_attempts: [],
    });
    const report = reportJob(root);
    assert.equal(report.totalTrials, 113);
    assert.equal(report.rows[0]?.accounting?.providerRequests, 2);
    assert.equal(report.recordedCost.totalUsd, "0.3");
    assert.equal(report.metrics.medianCacheHitRatePerSuccessfulTask.value, 0.9);
    assert.deepEqual(report.runnerSnapshot, { n_completed_trials: 1 });

    const bare = { model: "fixture", usage: { inputTokens: 900, inputTokenDetails: { cacheReadTokens: 0 } }, cost: { kind: "estimated" } };
    write(join(published, "digest", "digest.json"), {
        workspaces: [{ accounting: {
            requests: [...requests, bare], costUsd: "0.5",
            usage: { inputTokens: 1000, inputTokenDetails: { cacheReadTokens: 90 } },
        } }],
        provider_requests: [
            ...requests.map((accounting) => ({ kind: "emission", accounting })),
            { kind: "bare", accounting: bare },
        ],
        turn_attempts: [],
    });
    const withBare = reportJob(root);
    assert.equal(withBare.metrics.medianCacheHitRatePerSuccessfulTask.value, 0.09);
    assert.equal(withBare.rows[0]?.accounting?.providerRequests, 3);
    assert.equal(withBare.rows[0]?.accounting?.usage?.inputTokens, 1000);
    assert.equal(withBare.recordedCost.totalUsd, "0.5");
});
