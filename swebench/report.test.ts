import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyTurnsOf, render, summarize, verdictOf, webReferencesTaught, type TrialRow } from "./report.ts";

const row = (over: Partial<TrialRow>): TrialRow => ({
    instance: "django__django-11620", attempt: 1, model: "deepdumb", outcome: "fail", loopStatus: 200, reward: 0, emptyPatch: false, exception: null,
    turns: 12, requests: 12, rejectedEmissions: 0, tokens: { input: 400_000, cached: 100_000, output: 20_000, reasoning: 5_000 },
    costUsd: 0.12, wallMs: 600_000, emptyTurns: 0, webReferences: 0, webAttempts: 0, webReads: 0, mcpCalls: 0, refused: {}, evidence: "/tmp/x", ...over,
});

test("[§swebench-profiles] the campaign sheet counts friction before verdicts, and spend as medians", () => {
    const rows = [
        row({ reward: 1, costUsd: 0.10, turns: 8 }),
        row({ instance: "sympy__sympy-20590", emptyPatch: true, loopStatus: 500, refused: { EDIT: 2 }, rejectedEmissions: 1, costUsd: 0.30, turns: 40, emptyTurns: 3, webReferences: 2, webAttempts: 5, webReads: 3, mcpCalls: 1 }),
        row({ instance: "psf__requests-1963", reward: null, outcome: "error", exception: "TimeoutError: client budget", tokens: null, costUsd: null, wallMs: null }),
    ];
    const summary = summarize(rows);
    assert.deepEqual(summary.refusedByOp, { EDIT: 2 });
    assert.equal(summary.rejectedEmissions, 1);
    assert.equal(summary.emptyPatches, 1);
    assert.deepEqual(summary.exceptions, { TimeoutError: 1 });
    assert.equal(summary.emptyTurns, 3, "a turn the parser admits nothing from is friction, whatever grammar it was written in");
    assert.deepEqual(summary.isolation, { webReferences: 2, webAttempts: 5, webReads: 3, mcpCalls: 1, trialsTouched: 1 });
    assert.deepEqual(summary.loopsEnded, { "500": 1 }, "a loop the daemon ended is friction even when the oracle passes it");
    assert.deepEqual([summary.graded, summary.resolved, summary.resolveRate], [2, 1, 0.5]);
    assert.equal(summary.spend.totalUsd, 0.4);
    assert.equal(summary.spend.medianCostUsd, 0.2);
    assert.equal(summary.spend.medianGrossTokens, 420_000);
    assert.equal(summary.spend.medianTurns, 12);
    const sheet = render({ corpus: "harnesstax-swe-lite-30", model: "deepdumb", ids: ["a", "b", "c"] }, rows, summary);
    assert.match(sheet, /## Friction[\s\S]*## Verdicts[\s\S]*## Spend[\s\S]*## Trials/, "friction first, then verdicts, then spend");
    assert.match(sheet, /refused or failed operations by family: EDIT 2/);
    assert.match(sheet, /indecipherable turns \(no fence emitted\): 3/);
    assert.match(sheet, /2 web references taught, 5 model-issued web operations attempted, 3 served/);
    assert.match(sheet, /resolved 1 of 2 graded \(50\.0%\)/);
});

test("[§benchlet-isolation] the teaching check reads the first packet the model saw and counts only web scheme references", (t) => {
    const digest = mkdtempSync(join(tmpdir(), "swebench-digest-"));
    t.after(() => rmSync(digest, { recursive: true, force: true }));
    const survey = (names: string[]): string => names.map((name) => `[{"path":"worker:///_plurnk/plurnk/${name}.md","mimetype":"text/markdown"}]`).join("\n");
    writeFileSync(join(digest, "packet010.user.md"), survey(["sh", "worker"]));
    writeFileSync(join(digest, "packet007.user.md"), survey(["awk", "https", "https", "sh", "wss", "worker"]));
    assert.equal(webReferencesTaught(digest), 2, "https and wss, each once, from packet007 and not packet010");
    assert.equal(webReferencesTaught(join(digest, "missing")), 0);
    writeFileSync(join(digest, "packet008.assistant.md"), "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\">\n</｜｜DSML｜｜ calls>\n");
    writeFileSync(join(digest, "packet009.assistant.md"), "````NOTE\nordinary\n````\n");
    writeFileSync(join(digest, "packet010.assistant.md"), "I'll verify my implementation against a broader test run.\n");
    assert.equal(emptyTurnsOf(digest), 2, "the DSML turn and the prose turn are indecipherable; the fenced NOTE is not");
});

test("[§swebench-trial] the halt rule passes only a clean pass and names what to read otherwise", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "swebench-verdict-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const trial = (name: string, result: unknown, reward?: unknown): string => {
        const path = join(dir, name);
        mkdirSync(join(path, "verifier"), { recursive: true });
        writeFileSync(join(path, "result.json"), JSON.stringify(result));
        if (reward !== undefined) writeFileSync(join(path, "verifier", "reward.json"), JSON.stringify(reward));
        return path;
    };
    assert.equal(verdictOf(trial("pass", { exception_info: null }, { reward: 1 })), "pass");
    assert.equal(verdictOf(trial("fail", { exception_info: null }, { reward: 0 })), "fail: reward 0");
    assert.equal(
        verdictOf(trial("struck", { exception_info: { exception_type: "AgentExitError", exception_message: "the client exited 4" } }, { reward: 1 })),
        "agent: AgentExitError: the client exited 4",
        "a passing patch from a struck-out loop is read, not banked",
    );
    assert.equal(verdictOf(trial("spawn", { exception_info: { exception_type: "AgentSpawnError", exception_message: "ENOENT" } })), "harness: AgentSpawnError: ENOENT");
    assert.equal(verdictOf(trial("ungraded", { exception_info: null })), "harness: no verifier verdict");
    assert.equal(verdictOf(join(dir, "missing")), "harness: no result.json");
});
