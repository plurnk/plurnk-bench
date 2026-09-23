import assert from "node:assert/strict";
import test from "node:test";
import { render, summarize, type TrialRow } from "./report.ts";

const row = (over: Partial<TrialRow>): TrialRow => ({
    instance: "django__django-11620", attempt: 1, model: "deepdumb", outcome: "fail", loopStatus: 200, reward: 0, emptyPatch: false, exception: null,
    turns: 12, requests: 12, rejectedEmissions: 0, tokens: { input: 400_000, cached: 100_000, output: 20_000, reasoning: 5_000 },
    costUsd: 0.12, wallMs: 600_000, webAttempts: 0, webReads: 0, mcpCalls: 0, refused: {}, evidence: "/tmp/x", ...over,
});

test("[§swebench-profiles] the campaign sheet counts friction before verdicts, and spend as medians", () => {
    const rows = [
        row({ reward: 1, costUsd: 0.10, turns: 8 }),
        row({ instance: "sympy__sympy-20590", emptyPatch: true, loopStatus: 500, refused: { EDIT: 2 }, rejectedEmissions: 1, costUsd: 0.30, turns: 40, webAttempts: 5, webReads: 3, mcpCalls: 1 }),
        row({ instance: "psf__requests-1963", reward: null, outcome: "error", exception: "TimeoutError: client budget", tokens: null, costUsd: null, wallMs: null }),
    ];
    const summary = summarize(rows);
    assert.deepEqual(summary.refusedByOp, { EDIT: 2 });
    assert.equal(summary.rejectedEmissions, 1);
    assert.equal(summary.emptyPatches, 1);
    assert.deepEqual(summary.exceptions, { TimeoutError: 1 });
    assert.deepEqual(summary.isolation, { webAttempts: 5, webReads: 3, mcpCalls: 1, trialsTouched: 1 });
    assert.deepEqual(summary.loopsEnded, { "500": 1 }, "a loop the daemon ended is friction even when the oracle passes it");
    assert.deepEqual([summary.graded, summary.resolved, summary.resolveRate], [2, 1, 0.5]);
    assert.equal(summary.spend.totalUsd, 0.4);
    assert.equal(summary.spend.medianCostUsd, 0.2);
    assert.equal(summary.spend.medianGrossTokens, 420_000);
    assert.equal(summary.spend.medianTurns, 12);
    const sheet = render({ corpus: "harnesstax-swe-lite-30", model: "deepdumb", ids: ["a", "b", "c"] }, rows, summary);
    assert.match(sheet, /## Friction[\s\S]*## Verdicts[\s\S]*## Spend[\s\S]*## Trials/, "friction first, then verdicts, then spend");
    assert.match(sheet, /refused or failed operations by family: EDIT 2/);
    assert.match(sheet, /5 model-issued web operations attempted, 3 served/);
    assert.match(sheet, /resolved 1 of 2 graded \(50\.0%\)/);
});
