import assert from "node:assert/strict";
import test from "node:test";
import { baselinesFor, compare, compareBaselines, perTask, renderComparison } from "./comparison.ts";
import type { TrialRow } from "./report.ts";

const row = (over: Partial<TrialRow>): TrialRow => ({
    instance: "django__django-11620", attempt: 1, model: "deepdumb", outcome: "pass", loopStatus: 200, reward: 1, emptyPatch: false, exception: null,
    turns: 12, requests: 14, rejectedEmissions: 0, tokens: { input: 400_000, cached: 100_000, output: 20_000, reasoning: 5_000 },
    costUsd: 0.12, wallMs: 600_000, emptyTurns: 0, webReferences: 0, webAttempts: 0, webReads: 0, mcpCalls: 0, refused: {}, evidence: "/tmp/x", ...over,
});

const fixture = (): TrialRow[] => [
    row({ instance: "a", attempt: 1, reward: 1, costUsd: 0.10 }),
    row({ instance: "a", attempt: 2, reward: 1, costUsd: 0.30 }),
    row({ instance: "a", attempt: 3, reward: 0, costUsd: 0.20 }),
    row({ instance: "b", attempt: 1, reward: 0, costUsd: 0.40, requests: 40, turns: 30 }),
    row({ instance: "c", attempt: 1, reward: null, outcome: "error", exception: "TimeoutError: x", costUsd: null, tokens: null, requests: null }),
    row({ instance: "c", attempt: 2, reward: 1, costUsd: 0.50 }),
];

test("[§swebench-comparison] attempts average within each task before anything averages across tasks", () => {
    const tasks = perTask(fixture());
    assert.deepEqual(tasks.map((task) => [task.instance, task.attempts, task.graded, task.resolved, task.resolveRate]), [
        ["a", 3, 3, 2, 2 / 3],
        ["b", 1, 1, 0, 0],
        ["c", 2, 1, 1, 1],
    ], "an ungraded attempt is not a failure; it is absent from the task's rate");
    const close = (actual: number | null, expected: number): boolean => actual !== null && Math.abs(actual - expected) < 1e-12;
    assert.ok(tasks.every((task, index) => close(task.meanCostUsd, [0.2, 0.4, 0.5][index]!)), `mean cost per task: ${tasks.map((task) => task.meanCostUsd).join(", ")}`);
});

test("[§swebench-comparison] a comparison is per task against the study's successes of three, with wins, losses and ties", () => {
    const tasks = perTask(fixture());
    const baselines = new Map([
        ["a", { cc: 2, pi: 3 }],   // a: ours 2/3 → tie with cc, loss to pi
        ["b", { cc: 0, pi: 1 }],   // b: ours 0 → tie with cc, loss to pi
        ["c", { cc: 0, pi: 3 }],   // c: ours 1/1 → win over cc, tie with pi
    ]);
    const cc = compare(tasks, baselines, "cc", 500, "t");
    assert.ok(cc !== null);
    assert.deepEqual([cc.tasks, cc.wins, cc.losses, cc.ties, cc.label], [3, 1, 0, 2, "K3 · Claude Code"]);
    assert.ok(Math.abs(cc.differencePp - 100 / 3) < 1e-9, "(0 + 0 + 1) / 3 tasks = +33.3 pp");
    const pi = compare(tasks, baselines, "pi", 500, "t");
    assert.ok(pi !== null);
    assert.deepEqual([pi.wins, pi.losses, pi.ties], [0, 2, 1]);
    assert.equal(compare(tasks, new Map(), "codex", 10, "t"), null, "a baseline nobody carries is no comparison");
});

test("[§swebench-comparison] the campaign comparison carries the section-one row and the per-task matrix beside the baselines", () => {
    const baselines = new Map([["a", { cc: 3, codex: 3, pi: 2 }], ["b", { cc: 0, codex: 1, pi: 0 }], ["c", { cc: 3, codex: 3, pi: 3 }]]);
    const comparison = compareBaselines(fixture(), baselines, { resamples: 500, seed: "witness" });
    assert.equal(comparison.rollouts, 5, "graded rollouts");
    assert.equal(comparison.resolvedRollouts, 3);
    assert.ok(comparison.resolveRate !== null && Math.abs(comparison.resolveRate.mean - (2 / 3 + 0 + 1) / 3) < 1e-12, "the rate is the mean of per-task rates");
    assert.ok(comparison.costPerRollout !== null && Math.abs(comparison.costPerRollout.mean - (0.2 + 0.4 + 0.5) / 3) < 1e-12);
    assert.ok(comparison.costPerSolve !== null && Math.abs(comparison.costPerSolve - 1.5 / 3) < 1e-12, "total spend over resolved rollouts");
    assert.equal(comparison.medianGrossTokens, 420_000);
    assert.equal(comparison.medianCalls, 14);
    assert.deepEqual(comparison.baselineKeys, ["cc", "codex", "pi"]);
    assert.deepEqual(comparison.paired.map((entry) => entry.key), ["cc", "codex", "pi"]);
    assert.ok(comparison.paired.every((entry) => entry.pHolm >= entry.p && entry.pHolm <= 1));
    const lines = renderComparison(comparison, "Plurnk · deepdumb");
    const sheet = lines.join("\n");
    assert.equal(lines[0], "## Statistics");
    assert.match(sheet, /\| Plurnk · deepdumb \| 55\.6% \(3\/5\) \| \d+\.\d%–\d+\.\d% \| \$0\.367 \| \$\d\.\d{3}–\$\d\.\d{3} \| \$0\.500 \| 420,000 \| 14 \| 12 \|/);
    assert.match(sheet, /\| Plurnk · deepdumb vs K3 · Pi \| [+-]\d+\.\d pp \(-?\d+\.\d to -?\d+\.\d\) \| \d\.\d{4} \| \d\.\d{4} \| \d+ \/ \d+ \/ \d+ \|/);
    assert.match(sheet, /\| `a` \| 2\/3 \| 3\/3 \| 3\/3 \| 2\/3 \|/, "the matrix row: ours, then each baseline's successes of three");
    assert.match(sheet, /\| `c` \| 1\/1 \| 3\/3 \| 3\/3 \| 3\/3 \|/, "an ungraded attempt leaves the task's denominator");
});

test("[§swebench-comparison] [§swebench-corpus] the cited corpus carries the study's per-task baselines", () => {
    const baselines = baselinesFor("harnesstax-swe-lite-30");
    assert.ok(baselines !== null);
    assert.equal(baselines.size, 30);
    assert.deepEqual(baselines.get("astropy__astropy-7746"), { cc: 0, codex: 0, pi: 0 });
    assert.equal(baselinesFor("no-such-corpus"), null);
});
