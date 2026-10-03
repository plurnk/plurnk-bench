import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyTurnsOf, latestLaunches, readTrialRow, render, summarize, verdictOf, webReferencesTaught, type DigestTurn, type TrialRow } from "./report.ts";
import { compareBaselines } from "./comparison.ts";
import { readDigest } from "../src/digest.ts";

const row = (over: Partial<TrialRow>): TrialRow => ({
    instance: "django__django-11620", attempt: 1, model: "deepdumb", outcome: "fail", loopStatus: 200, reward: 0, emptyPatch: false, exception: null,
    turns: 12, requests: 12, rejectedEmissions: 0, tokens: { input: 400_000, cached: 100_000, output: 20_000, reasoning: 5_000 },
    costUsd: 0.12, knownCostUsd: over.costUsd === undefined ? 0.12 : over.costUsd,
    pricedRequests: over.costUsd === null ? 0 : 12, costEvidence: { charged: 12, estimated: 0, unknown: 0 },
    wallMs: 600_000, emptyTurns: 0, webReferences: 0, webAttempts: 0, webReads: 0, mcpCalls: 0, refused: {}, edits: null, evidence: "/tmp/x", ...over,
});

test("{§accounting-cost-completeness} incomplete trials retain known spend but do not reduce cost metrics", () => {
    const rows = [
        row({ instance: "complete", costUsd: 0.2, reward: 1 }),
        row({ instance: "partial", costUsd: null, knownCostUsd: 0.01, pricedRequests: 11,
            costEvidence: { charged: 0, estimated: 11, unknown: 1 } }),
    ];
    const summary = summarize(rows);
    assert.equal(summary.spend.totalUsd, null);
    assert.ok(Math.abs(summary.spend.knownUsd! - 0.21) < 1e-12);
    assert.equal(summary.spend.pricedTrials, 1);
    assert.equal(summary.spend.medianCostUsd, 0.2);
    const comparison = compareBaselines(rows, new Map(), { resamples: 10 });
    assert.equal(comparison.costPerSolve, null);
    const sheet = render({}, rows, summary, comparison);
    assert.match(sheet, /known subtotal \$0\.210/u);
    assert.match(sheet, /complete costs 1\/2 trials/u);
    assert.match(sheet, /11\/12/u);
});

test("{§accounting-cost-completeness} saved SWE-bench trials keep incomplete request costs out of comparisons", (t) => {
    const trial = mkdtempSync(join(tmpdir(), "swebench-cost-"));
    t.after(() => rmSync(trial, { recursive: true, force: true }));
    mkdirSync(join(trial, "agent", "digest"), { recursive: true });
    mkdirSync(join(trial, "verifier"));
    const write = (file: string, value: unknown) => writeFileSync(join(trial, file), JSON.stringify(value));
    write("result.json", { trial_name: "fixture", task_name: "fixture" });
    write("agent/plurnk.json", { schemaVersion: 6, finalStatus: 200, wallMs: 10 });
    write("verifier/reward.json", { reward: 1 });
    const requests = [
        { model: "fixture", cost: { kind: "charged", amount: { amount: "0.01", currency: "USD" }, source: "fixture" } },
        { model: "fixture", cost: { kind: "unknown", reason: "No usage received." } },
    ];
    write("agent/digest/digest.json", {
        workspaces: [{ accounting: { requests, costUsd: "0.01", usage: null } }],
        provider_requests: requests.map((accounting) => ({ kind: "emission", accounting })), turn_attempts: [],
    });
    const result = readTrialRow(trial, 1);
    assert.ok(result);
    assert.equal(result.costUsd, null);
    assert.equal(result.knownCostUsd, 0.01);
    assert.equal(result.pricedRequests, 1);
    assert.equal(result.requests, 2);
    assert.deepEqual(result.costEvidence, { charged: 1, estimated: 0, unknown: 1 });
    const comparison = compareBaselines([result], new Map(), { resamples: 10 });
    assert.equal(comparison.costPerRollout, null);
    assert.equal(comparison.costPerSolve, null);
    assert.deepEqual(comparison.costCoverage, { rollouts: 0, totalRollouts: 1, tasks: 0, totalTasks: 1 });
    write("agent/digest/digest.json", {
        workspaces: [{ accounting: { requests, costUsd: null, knownCostUsd: "0.01",
            usage: { inputTokens: 10 }, knownUsage: { inputTokens: 10, outputTokens: 5 } } }],
        provider_requests: requests.map((accounting) => ({ kind: "emission", accounting })), turn_attempts: [],
    });
    const incomplete = readTrialRow(trial, 1)!;
    assert.equal(incomplete.knownCostUsd, 0.01);
    assert.deepEqual(incomplete.tokens, { input: 10, output: null, cached: null, reasoning: null });
    assert.equal(summarize([incomplete]).spend.medianGrossTokens, null);
    assert.equal(compareBaselines([incomplete], new Map(), { resamples: 10 }).medianGrossTokens, null);
    assert.match(render({}, [incomplete], summarize([incomplete])), /\| 10 \| — \| — \| — \|/u);
});

test("[§swebench-profiles] the campaign sheet counts friction before verdicts, and spend as medians", () => {
    const rows = [
        row({ reward: 1, costUsd: 0.10, turns: 8, edits: { count: 5, refused: 0, revisits: 1, forms: { hash: 4, whole: 1 } } }),
        row({ instance: "sympy__sympy-20590", emptyPatch: true, loopStatus: 500, refused: { EDIT: 2 }, rejectedEmissions: 1, costUsd: 0.30, turns: 40, emptyTurns: 3, webReferences: 2, webAttempts: 5, webReads: 3, mcpCalls: 1 }),
        row({ instance: "psf__requests-1963", reward: null, outcome: "error", exception: "TimeoutError: client budget", tokens: null, costUsd: null, wallMs: null }),
    ];
    const summary = summarize(rows);
    assert.deepEqual(summary.refusedByOp, { EDIT: 2 });
    assert.equal(summary.rejectedEmissions, 1);
    assert.equal(summary.emptyPatches, 1);
    assert.deepEqual(summary.exceptions, { TimeoutError: 1 });
    assert.equal(summary.emptyTurns, 3, "a turn the parser admits nothing from is friction, whatever grammar it was written in");
    assert.deepEqual(summary.edits, { count: 5, refused: 0, revisits: 1, forms: { hash: 4, whole: 1 } }, "the service's `§digest-edit-census` the EDIT census sums over trials; a trial without one adds nothing");
    assert.deepEqual(summary.isolation, { webReferences: 2, webAttempts: 5, webReads: 3, mcpCalls: 1, trialsTouched: 1 });
    assert.deepEqual(summary.loopsEnded, { "500": 1 }, "a loop the daemon ended is friction even when the oracle passes it");
    assert.deepEqual([summary.graded, summary.resolved, summary.resolveRate], [2, 1, 0.5]);
    assert.equal(summary.spend.totalUsd, null, "an unpriced trial precludes a complete total");
    assert.equal(summary.spend.knownUsd, 0.4);
    assert.equal(summary.spend.medianCostUsd, 0.2);
    assert.equal(summary.spend.medianGrossTokens, 420_000);
    assert.equal(summary.spend.medianTurns, 12);
    const sheet = render({ corpus: "harnesstax-swe-lite-30", model: "deepdumb", ids: ["a", "b", "c"] }, rows, summary);
    assert.match(sheet, /## Friction[\s\S]*## Verdicts[\s\S]*## Spend[\s\S]*## Trials/, "friction first, then verdicts, then spend");
    assert.match(sheet, /refused or failed operations by family: EDIT 2/);
    assert.match(sheet, /indecipherable turns \(no fence emitted\): 3/);
    assert.match(sheet, /- EDITs: 5 \(hash 4, whole 1\) · refused 0 · revisits 1/, "EDIT friction reads on the sheet before verdicts");
    assert.match(sheet, /\| 5\/0\/1 \|/, "a trial row carries count\/refused\/revisits");
    assert.match(sheet, /\| — \| TimeoutError/, "a trial whose digest has no census reads as unknown, not zero");
    assert.match(sheet, /2 web references taught, 5 model-issued web operations attempted, 3 served/);
    assert.match(sheet, /resolved 1 of 2 graded \(50\.0%\)/);
    // {§swebench-comparison} — with baselines the statistics section sits after spend, before the rows.
    const compared = render({ corpus: "harnesstax-swe-lite-30", model: "deepdumb", ids: ["a", "b", "c"] }, rows, summary, compareBaselines(rows, new Map([["django__django-11620", { cc: 3, codex: 3, pi: 3 }]]), { resamples: 100, seed: "t" }));
    assert.match(compared, /## Spend[\s\S]*## Statistics[\s\S]*\| Plurnk · deepdumb \|[\s\S]*## Trials/, "friction, verdicts, spend, statistics, rows");
    assert.ok(!sheet.includes("## Statistics"), "no baselines, no statistics section");
});

test("[§benchlet-isolation] {§share-packet-names} the teaching check reads the first packet the model saw, by the digest's own turn order and artifact names, and counts only web scheme references", (t) => {
    const digest = mkdtempSync(join(tmpdir(), "swebench-digest-"));
    t.after(() => rmSync(digest, { recursive: true, force: true }));
    const survey = (names: string[]): string => names.map((name) => `[{"path":"worker:///_plurnk/plurnk/${name}.md","mimetype":"text/markdown"}]`).join("\n");
    // The initialization survey (turn 1) writes no packet; the model's first turn is <worker>-1-2.
    // Directory listing order (worker-1-10 before worker-1-2) is not turn order; digest.json is.
    writeFileSync(join(digest, "worker-1-10.user.md"), survey(["sh", "worker"]));
    writeFileSync(join(digest, "worker-1-2.user.md"), survey(["awk", "https", "https", "sh", "wss", "worker"]));
    writeFileSync(join(digest, "digest.json"), JSON.stringify({ turns: [
        { artifact: null }, { artifact: "worker-1-2" }, { artifact: "worker-1-3" }, { artifact: "worker-1-4" }, { artifact: "worker-1-10" },
    ] }));
    const { turns } = readDigest<{ turns: DigestTurn[] }>(join(digest, "digest.json"));
    assert.equal(webReferencesTaught(digest, turns), 2, "https and wss, each once, from worker-1-2 and not worker-1-10");
    assert.equal(webReferencesTaught(digest, []), 0, "no turns, nothing taught");
    assert.equal(webReferencesTaught(digest, [{ artifact: "worker-1-3" }]), 0, "a turn that stored no request has no user packet");
    writeFileSync(join(digest, "worker-1-3.assistant.md"), "<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\">\n</｜｜DSML｜｜ calls>\n");
    writeFileSync(join(digest, "worker-1-4.assistant.md"), "````NOTE\nordinary\n````\n");
    writeFileSync(join(digest, "worker-1-10.assistant.md"), "I'll verify my implementation against a broader test run.\n");
    writeFileSync(join(digest, "packet011.assistant.md"), "prose under a name the digest does not claim\n");
    assert.equal(emptyTurnsOf(digest, turns), 2, "the DSML turn and the prose turn are indecipherable; the fenced NOTE is not; an unclaimed file is not a turn");
});

test("[§swebench-trial] the halt rule passes only a clean pass and names what to read otherwise", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "swebench-verdict-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const trial = (name: string, result: unknown, reward?: unknown, loopStatus?: number): string => {
        const path = join(dir, name);
        mkdirSync(join(path, "verifier"), { recursive: true });
        writeFileSync(join(path, "result.json"), JSON.stringify(result));
        if (reward !== undefined) writeFileSync(join(path, "verifier", "reward.json"), JSON.stringify(reward));
        if (loopStatus !== undefined) {
            mkdirSync(join(path, "agent", "digest"), { recursive: true });
            writeFileSync(join(path, "agent", "plurnk.json"), JSON.stringify({ schemaVersion: 6, finalStatus: loopStatus }));
            writeFileSync(join(path, "agent", "digest", "digest.json"), JSON.stringify({ loops: [{ status: loopStatus }] }));
        }
        return path;
    };
    assert.equal(verdictOf(trial("pass", { exception_info: null }, { reward: 1 })), "pass");
    assert.equal(verdictOf(trial("fail", { exception_info: null }, { reward: 0 })), "fail: reward 0");
    const exited = (code: number) => ({ exception_info: { exception_type: "AgentExitError", exception_message: `the client exited ${code}` } });
    assert.equal(verdictOf(trial("struck", exited(4), { reward: 1 }, 500)), "pass (strike threshold)",
        "the oracle grades the patch; the engine's ending decorates it, so the strict halt reads it and the clean halt runs on");
    assert.equal(verdictOf(trial("capped", exited(2), undefined, 429)), "fail: turn ceiling exhausted", "a capped loop with no verdict is the model's outcome, not the agent's (#46)");
    assert.equal(verdictOf(trial("capped-miss", exited(2), { reward: 0 }, 429)), "fail: reward 0 (turn ceiling exhausted)");
    assert.equal(verdictOf(trial("exited", exited(4))), "agent: AgentExitError: the client exited 4", "an exit with no loop terminal and no verdict is the agent's");
    assert.equal(verdictOf(trial("spawn", { exception_info: { exception_type: "AgentSpawnError", exception_message: "ENOENT" } })), "harness: AgentSpawnError: ENOENT");
    const cancelled = { exception_info: { exception_type: "AgentCancelledError", exception_message: "operator stopped" } };
    assert.equal(verdictOf(trial("cancelled", cancelled, { reward: 0 })), "fail: reward 0 (externally cancelled)");
    assert.equal(verdictOf(trial("cancelled-pass", cancelled, { reward: 1 })), "pass (externally cancelled)");
    assert.equal(verdictOf(trial("cancelled-ungraded", cancelled)), "agent: AgentCancelledError: operator stopped");
    assert.equal(verdictOf(trial("ungraded", { exception_info: null })), "harness: no verifier verdict");
    assert.equal(verdictOf(join(dir, "missing")), "harness: no result.json");
});

test("{§swebench-trial} a failed child cannot label the root as struck out", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "swebench-root-status-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "agent", "digest"), { recursive: true });
    mkdirSync(join(dir, "verifier"));
    writeFileSync(join(dir, "result.json"), JSON.stringify({ exception_info: null }));
    writeFileSync(join(dir, "verifier", "reward.json"), JSON.stringify({ reward: 1 }));
    writeFileSync(join(dir, "agent", "digest", "digest.json"), JSON.stringify({ loops: [{ id: 1, status: 200 }, { id: 2, status: 500 }] }));
    writeFileSync(join(dir, "agent", "plurnk.json"), JSON.stringify({ schemaVersion: 6, loopId: 1, finalStatus: 200 }));
    assert.equal(verdictOf(dir), "pass");
    rmSync(join(dir, "agent", "plurnk.json"));
    assert.equal(verdictOf(dir), "pass", "without a root result the digest cannot supply a guessed root failure");
});

test("[§swebench-profiles] a re-run of the same instance and attempt supersedes its earlier row", () => {
    const launched = [
        { instance: "psf__requests-1963", attempt: 1, trial: "/t/a" },
        { instance: "django__django-12308", attempt: 1, trial: "/t/b" },
        { instance: "psf__requests-1963", attempt: 1, trial: "/t/c" },
    ];
    assert.deepEqual(latestLaunches(launched).map(({ trial }) => trial), ["/t/c", "/t/b"], "the later verdict stands, in first-seen order");
});
