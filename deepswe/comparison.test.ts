import { test } from "node:test";
import assert from "node:assert/strict";
import { compareBaseline } from "./comparison.ts";
import type { TaskReport } from "./report.ts";

const candidate = (task: string, reward: number | null): TaskReport => ({
    task: `datacurve/${task}`, reward, outcome: "fail", durationMs: 1000,
    evidence: "/fixture", accounting: null, costEvidence: null,
});
const peer = (task_name: string, score_value: number, config = "max") => ({
    task_name, score_value, config, included_in_score: true, model: "model", reasoning_effort: "max",
    n_input_tokens: 100, n_cache_tokens: 80, n_output_tokens: 10, agent_duration_seconds: 2,
});

test("{§deepswe-comparison} compare the same graded tasks at the exact selected profile, without best-of picking", () => {
    const result = compareBaseline([candidate("a", 1), candidate("b", 0), candidate("pending", null)], [
        peer("a", 1), peer("a", 0), peer("b", 1), peer("b", 0), peer("pending", 1),
        peer("a", 1, "medium"), { ...peer("b", 1), included_in_score: false },
    ], "max");
    assert.equal(result.matchedTasks, 2);
    assert.deepEqual(result.candidate, { passed: 1, attempted: 2, passRate: 0.5 });
    assert.deepEqual(result.baseline.score, { passed: 2, attempted: 4, passRate: 0.5 });
    assert.equal(result.baseline.medianInputTokens, 100);
    assert.equal(result.tasks[0]?.baselineAttempts, 2);
    assert.deepEqual(result.unmatchedTasks, []);
});

test("{§deepswe-comparison} missing peer tasks and profiles remain explicit", () => {
    const result = compareBaseline([candidate("absent", 0)], [peer("other", 1)], "max");
    assert.deepEqual(result.unmatchedTasks, ["absent"]);
    assert.equal(result.candidate.passRate, null);
    assert.throws(() => compareBaseline([], [peer("a", 1)], "missing"), /no scored trials/);
});
