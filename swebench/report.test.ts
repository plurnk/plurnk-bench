import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { latestLaunches, readTrialRow, render, requireSettledEvaluation, summarize, verdictOf, webReferencesTaught, type TrialRow } from "./report.ts";
import { frictionOf, summarizeFriction, type DigestTurn } from "./friction.ts";
import { compareBaselines, baselinesFor, compare, perTask, renderComparison } from "./comparison.ts";
import { readDigest } from "../src/digest.ts";
import { corpusIds, donePairs, planTrials } from "./plan.ts";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs/promises";
import { candidateArgv, exceptionInfo, extractPlurnkDoc, gradingOutcome, runToFiles, taskPrompt } from "./run.ts";
import { citedInstances, rankBySeed, repoCounts, stratifiedDraw, uniformDraw } from "./sample.ts";

// ─── report.test.ts ───
{
const row = (over: Partial<TrialRow>): TrialRow => ({
    instance: "django__django-11620", attempt: 1, model: "deepdumb", outcome: "fail", loopStatus: 200, reward: 0, emptyPatch: false, exception: null, evaluation: null,
    turns: 12, requests: 12, rejectedEmissions: 0, tokens: { input: 400_000, cached: 100_000, output: 20_000, reasoning: 5_000 },
    costUsd: 0.12, knownCostUsd: over.costUsd === undefined ? 0.12 : over.costUsd,
    pricedRequests: over.costUsd === null ? 0 : 12, costEvidence: { charged: 12, estimated: 0, unknown: 0 },
    wallMs: 600_000, friction: frictionOf({ turns: [], turn_attempts: [], log_entries: [] }), webReferences: 0, webAttempts: 0, webReads: 0, mcpCalls: 0, edits: null, evidence: "/tmp/x", ...over,
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
    assert.match(sheet, /complete costs 1\/2 trials · complete usage 2\/2 trials/u);
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
    assert.equal(summarize([incomplete]).spend.usageTrials, 0, "a trial without both complete counts is outside the token median's coverage");
    assert.match(render({}, [incomplete], summarize([incomplete])), /complete usage 0\/1 trials/u);
    assert.equal(compareBaselines([incomplete], new Map(), { resamples: 10 }).medianGrossTokens, null);
    assert.match(render({}, [incomplete], summarize([incomplete])), /\| 10 \| — \| — \| — \|/u);
});

test("{§swebench-comparison} the campaign sheet counts friction before verdicts, and spend as medians", () => {
    const rows = [
        row({ reward: 1, costUsd: 0.10, turns: 8, edits: { count: 5, refused: 0, revisits: 1, forms: { hash: 4, whole: 1 } } }),
        row({ instance: "sympy__sympy-20590", emptyPatch: true, loopStatus: 500, friction: frictionOf({
            turns: [1, 2, 3].map((id) => ({ id, program: "hello" })), turn_attempts: [1, 2, 3].map((turn_id) => ({ turn_id })),
            log_entries: [1, 2].map(() => ({ origin: "model", inherited_history: false, op: "EDIT", status_rx: 422 })).concat(
                [1, 2, 3].map((turn_id) => ({ origin: "_plurnk", inherited_history: false, ambient_event_id: null,
                    turn_id, op: "error", status_rx: 422, problem: { type: "https://problems.plurnk.xyz/engine/rail/no-operation" } }))),
        }), rejectedEmissions: 1, costUsd: 0.30, turns: 40, webReferences: 2, webAttempts: 5, webReads: 3, mcpCalls: 1 }),
        row({ instance: "psf__requests-1963", reward: null, outcome: "error", exception: "TimeoutError: client budget", tokens: null, costUsd: null, wallMs: null }),
    ];
    const summary = summarize(rows);
    assert.deepEqual(summary.friction.receipts?.authored, { EDIT: 2 });
    assert.equal(summary.rejectedEmissions, 1);
    assert.equal(summary.emptyPatches, 1);
    assert.deepEqual(summary.exceptions, { TimeoutError: 1 });
    assert.equal(summary.friction.turns?.noOperation, 3, "engine outcomes, not raw formatting, establish no-operation turns");
    assert.deepEqual(summary.edits, { count: 5, refused: 0, revisits: 1, forms: { hash: 4, whole: 1 } }, "the EDIT census sums over trials; a trial without one adds nothing");
    assert.deepEqual(summary.isolation, { webReferences: 2, webAttempts: 5, webReads: 3, mcpCalls: 1, trialsTouched: 1, classifiedTrials: 3 });
    assert.deepEqual(summary.loopsEnded, { "500": 1 }, "a loop the daemon ended is friction even when the oracle passes it");
    assert.deepEqual([summary.graded, summary.resolved, summary.resolveRate], [2, 1, 0.5]);
    assert.equal(summary.spend.totalUsd, null, "an unpriced trial precludes a complete total");
    assert.equal(summary.spend.knownUsd, 0.4);
    assert.equal(summary.spend.medianCostUsd, 0.2);
    assert.equal(summary.spend.medianGrossTokens, 420_000);
    assert.equal(summary.spend.usageTrials, 2, "the median covers the two trials with complete usage");
    assert.equal(summary.spend.medianTurns, 12);
    const sheet = render({ corpus: "harnesstax-swe-lite-30", model: "deepdumb", ids: ["a", "b", "c"] }, rows, summary);
    assert.match(sheet, /## Friction[\s\S]*## Verdicts[\s\S]*## Spend[\s\S]*## Trials/, "friction first, then verdicts, then spend");
    assert.match(sheet, /failed authored receipts by family: EDIT 2/);
    assert.match(sheet, /fence-free content: 3; with admitted content operations: 0; engine no-operation outcomes: 3/);
    assert.match(sheet, /turn evidence: 3\/3 trials; raw content 3\/3 model turns/);
    assert.match(sheet, /- EDITs: 5 \(hash 4, whole 1\) · refused 0 · revisits 1/, "EDIT friction reads on the sheet before verdicts");
    assert.match(sheet, /\| 5\/0\/1 \|/, "a trial row carries count\/refused\/revisits");
    assert.match(sheet, /\| — \| TimeoutError/, "a trial whose digest has no census reads as unknown, not zero");
    assert.match(sheet, /2 web references taught; 3\/3 trials with classified operations: 5 model-issued web operations attempted, 3 served/);
    assert.match(sheet, /resolved 1 of 2 graded \(50\.0%\)/);
    // {§swebench-comparison} — with baselines the statistics section sits after spend, before the rows.
    const compared = render({ corpus: "harnesstax-swe-lite-30", model: "deepdumb", ids: ["a", "b", "c"] }, rows, summary, compareBaselines(rows, new Map([["django__django-11620", { cc: 3, codex: 3, pi: 3 }]]), { resamples: 100, seed: "t" }));
    assert.match(compared, /## Spend[\s\S]*## Statistics[\s\S]*\| Plurnk · deepdumb \|[\s\S]*## Trials/, "friction, verdicts, spend, statistics, rows");
    assert.ok(!sheet.includes("## Statistics"), "no baselines, no statistics section");
});

test("{§benchlet-diagnostic} the teaching check reads the first packet the model saw, by the digest's own turn order and artifact names, and counts only web scheme references", (t) => {
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
});

test("{§swebench-evaluator} a saved verdict settles a candidate under clean; under pass an abnormal evaluator exit beside it is the evaluator's to settle; no verdict settles nothing", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "swebench-settled-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const candidate = (name: string, reward?: unknown): string => {
        const path = join(dir, name);
        mkdirSync(join(path, "artifacts"), { recursive: true });
        mkdirSync(join(path, "verifier"), { recursive: true });
        writeFileSync(join(path, "artifacts", "model.patch"), "candidate");
        writeFileSync(join(path, "verifier", "evaluation.json"), JSON.stringify({ state: "finished", exitCode: 1, diagnostics: ["official evaluator exited 1"] }));
        if (reward !== undefined) writeFileSync(join(path, "verifier", "reward.json"), JSON.stringify(reward));
        return path;
    };
    const graded = candidate("graded", { reward: 1 });
    assert.doesNotThrow(() => requireSettledEvaluation(graded, "clean"), "the report is the grading; the evaluator's exit rides it as a diagnostic");
    assert.throws(() => requireSettledEvaluation(graded, "pass"), /retry swebench\/evaluate\.ts/u, "the strict policy regrades or skips a blemished pass, never buys it again");
    const ungraded = candidate("ungraded");
    for (const policy of ["pass", "clean"] as const) assert.throws(() => requireSettledEvaluation(ungraded, policy), /retry swebench\/evaluate\.ts/u);
});

test("{§swebench-evaluator} the halt rule passes only a clean pass and names what to read otherwise", (t) => {
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

test("{§swebench-evaluator} a failed child cannot label the root as struck out", (t) => {
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

test("{§swebench-comparison} a re-run of the same instance and attempt supersedes its earlier row", () => {
    const launched = [
        { instance: "psf__requests-1963", attempt: 1, trial: "/t/a" },
        { instance: "django__django-12308", attempt: 1, trial: "/t/b" },
        { instance: "psf__requests-1963", attempt: 1, trial: "/t/c" },
    ];
    assert.deepEqual(latestLaunches(launched).map(({ trial }) => trial), ["/t/c", "/t/b"], "the later verdict stands, in first-seen order");
});
}

// ─── comparison.test.ts ───
{
const row = (over: Partial<TrialRow>): TrialRow => ({
    instance: "django__django-11620", attempt: 1, model: "deepdumb", outcome: "pass", loopStatus: 200, reward: 1, emptyPatch: false, exception: null, evaluation: null,
    turns: 12, requests: 14, rejectedEmissions: 0, tokens: { input: 400_000, cached: 100_000, output: 20_000, reasoning: 5_000 },
    costUsd: 0.12, knownCostUsd: over.costUsd === undefined ? 0.12 : over.costUsd,
    pricedRequests: over.costUsd === null ? 0 : 14, costEvidence: { charged: 14, estimated: 0, unknown: 0 },
    wallMs: 600_000, friction: frictionOf({ turns: [], turn_attempts: [], log_entries: [] }), webReferences: 0, webAttempts: 0, webReads: 0, mcpCalls: 0, edits: null, evidence: "/tmp/x", ...over,
});

const fixture = (): TrialRow[] => [
    row({ instance: "a", attempt: 1, reward: 1, costUsd: 0.10 }),
    row({ instance: "a", attempt: 2, reward: 1, costUsd: 0.30 }),
    row({ instance: "a", attempt: 3, reward: 0, costUsd: 0.20 }),
    row({ instance: "b", attempt: 1, reward: 0, costUsd: 0.40, requests: 40, turns: 30 }),
    row({ instance: "c", attempt: 1, reward: null, outcome: "error", exception: "TimeoutError: x", costUsd: null, tokens: null, requests: null }),
    row({ instance: "c", attempt: 2, reward: 1, costUsd: 0.50 }),
];

test("{§swebench-comparison} attempts average within each task before anything averages across tasks", () => {
    const tasks = perTask(fixture());
    assert.deepEqual(tasks.map((task) => [task.instance, task.attempts, task.graded, task.resolved, task.resolveRate]), [
        ["a", 3, 3, 2, 2 / 3],
        ["b", 1, 1, 0, 0],
        ["c", 2, 1, 1, 1],
    ], "an ungraded attempt is not a failure; it is absent from the task's rate");
    const close = (actual: number | null, expected: number): boolean => actual !== null && Math.abs(actual - expected) < 1e-12;
    assert.ok(close(tasks[0]!.meanCostUsd, 0.2));
    assert.ok(close(tasks[1]!.meanCostUsd, 0.4));
    assert.equal(tasks[2]!.meanCostUsd, null, "one missing attempt cost prevents the full-task average");
});

test("{§swebench-comparison} a comparison is per task against the study's successes of three, with wins, losses and ties", () => {
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

test("{§swebench-comparison} the campaign comparison carries the section-one row and the per-task matrix beside the baselines", () => {
    const baselines = new Map([["a", { cc: 3, codex: 3, pi: 2 }], ["b", { cc: 0, codex: 1, pi: 0 }], ["c", { cc: 3, codex: 3, pi: 3 }]]);
    const comparison = compareBaselines(fixture(), baselines, { resamples: 500, seed: "witness" });
    assert.equal(comparison.rollouts, 5, "graded rollouts");
    assert.equal(comparison.resolvedRollouts, 3);
    assert.ok(comparison.resolveRate !== null && Math.abs(comparison.resolveRate.mean - (2 / 3 + 0 + 1) / 3) < 1e-12, "the rate is the mean of per-task rates");
    assert.ok(comparison.costPerRollout !== null && Math.abs(comparison.costPerRollout.mean - (0.2 + 0.4) / 2) < 1e-12);
    assert.equal(comparison.costPerSolve, null, "cost per solve needs every trial's spend");
    assert.deepEqual(comparison.costCoverage, { rollouts: 5, totalRollouts: 6, tasks: 2, totalTasks: 3 });
    assert.equal(comparison.medianGrossTokens, 420_000);
    assert.equal(comparison.medianCalls, 14);
    assert.deepEqual(comparison.baselineKeys, ["cc", "codex", "pi"]);
    assert.deepEqual(comparison.paired.map((entry) => entry.key), ["cc", "codex", "pi"]);
    assert.ok(comparison.paired.every((entry) => entry.pHolm >= entry.p && entry.pHolm <= 1));
    const lines = renderComparison(comparison, "Plurnk · deepdumb");
    const sheet = lines.join("\n");
    assert.equal(lines[0], "## Statistics");
    assert.match(sheet, /Cost coverage: 5\/6 rollouts, 2\/3 tasks/u);
    assert.match(sheet, /\| Plurnk · deepdumb \| 55\.6% \(3\/5\) \| \d+\.\d%–\d+\.\d% \| \$0\.300 \| \$\d\.\d{3}–\$\d\.\d{3} \| — \| 420,000 \| 14 \| 12 \|/);
    assert.match(sheet, /\| Plurnk · deepdumb vs K3 · Pi \| [+-]\d+\.\d pp \(-?\d+\.\d to -?\d+\.\d\) \| \d\.\d{4} \| \d\.\d{4} \| \d+ \/ \d+ \/ \d+ \|/);
    assert.match(sheet, /\| `a` \| 2\/3 \| 3\/3 \| 3\/3 \| 2\/3 \|/, "the matrix row: ours, then each baseline's successes of three");
    assert.match(sheet, /\| `c` \| 1\/1 \| 3\/3 \| 3\/3 \| 3\/3 \|/, "an ungraded attempt leaves the task's denominator");
});

test("{§swebench-comparison} {§swebench-evaluator} the cited corpus carries the study's per-task baselines", () => {
    const baselines = baselinesFor("harnesstax-swe-lite-30");
    assert.ok(baselines !== null);
    assert.equal(baselines.size, 30);
    assert.deepEqual(baselines.get("astropy__astropy-7746"), { cc: 0, codex: 0, pi: 0 });
    assert.equal(baselinesFor("no-such-corpus"), null);
});
}

// ─── friction.test.ts ───
{
const noOperation = "https://problems.plurnk.xyz/engine/rail/no-operation";
const nonzero = "https://problems.plurnk.xyz/executor/subprocess/nonzero-exit";
const range = "https://problems.plurnk.xyz/scheme/file/range";

const entry = (over: Record<string, unknown> = {}) => ({
    id: 1, turn_id: 1, worker_id: 1, origin: "model", source: null,
    inherited_history: false, ambient_event_id: null, attrs: {}, op: "READ",
    target: "file.txt", status_rx: 200, ...over,
});

const trial = (t: TestContext, turns: Array<{ id: number; program?: string | null }>, entries: object[]) => {
    const root = mkdtempSync(join(tmpdir(), "swebench-friction-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "agent", "digest"), { recursive: true });
    mkdirSync(join(root, "verifier"));
    const write = (file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value));
    write("result.json", { trial_name: "fixture", task_name: "fixture" });
    write("agent/plurnk.json", { schemaVersion: 6, finalStatus: 200, wallMs: 10 });
    write("verifier/reward.json", { reward: 1 });
    const savedTurns = turns.map((turn) => {
        const artifact = `worker-1-${turn.id}`;
        if (typeof turn.program === "string") writeFileSync(join(root, "agent", "digest", `${artifact}.assistant.md`), turn.program);
        return { ...turn, artifact };
    });
    write("agent/digest/digest.json", {
        workspaces: [{ accounting: { requests: [], costUsd: "0", usage: null } }],
        provider_requests: [], turn_attempts: turns.map((_, index) => ({ turn_id: index + 1, accepted: true })),
        turns: savedTurns, log_entries: entries,
    });
    return readTrialRow(root, 1)!;
};

test("{§swebench-comparison} nineteen fence-free emissions include seven admitted programs and twelve no-operation turns", (t) => {
    const turns = Array.from({ length: 19 }, (_, index) => ({
        id: index + 1, producer: "model", program: index < 7 ? "<invoke name=\"sh\">printf 42</invoke>" : "I will inspect the project.",
    }));
    const entries = turns.flatMap(({ id }) => id <= 7 ? [
        entry({ id: id * 2, turn_id: id, origin: "_plurnk", attrs: { kind: "emission" } }),
        entry({ id: id * 2 + 1, turn_id: id, op: "sh", target: null, attrs: { stream: `sh:///${id}` } }),
    ] : [entry({ id: id * 2, turn_id: id, origin: "_plurnk", source: "rail", op: "error", target: null,
        status_rx: 422, problem: { type: noOperation } })]);
    const row = trial(t, turns, entries);
    assert.deepEqual(row.friction.turns, {
        modelTurns: 19, rawEmissions: 19, fenceFree: 19, fenceFreeAdmitted: 7, noOperation: 12,
    });
});

test("{§swebench-comparison} admission outcomes do not follow fence shape, content presence, or copied programs", () => {
    const result = frictionOf({
        turn_attempts: [{ turn_id: 1 }, { turn_id: 2 }, { turn_id: 2 }, { turn_id: 3 }, { turn_id: 4 }],
        turns: [
            { id: 0, program: "initialization" }, { id: 1, program: "" },
            { id: 2, program: "```not-an-operation\n```" }, { id: 3, program: "```READ (file)```" },
            { id: 4, program: null }, { id: 5, program: "copied no-operation" },
        ],
        log_entries: [
            entry({ turn_id: 1, op: "READ" }), // Reasoning-only operation, no content emission row.
            entry({ turn_id: 1, origin: "_plurnk", op: "READ", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 1, origin: "_plurnk", ambient_event_id: 7, op: "error", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 2, origin: "_plurnk", op: "error", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 2, origin: "_plurnk", op: "error", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 3, origin: "_plurnk", attrs: { kind: "emission" } }),
            entry({ turn_id: 5, origin: "_plurnk", inherited_history: true, op: "error", problem: { type: noOperation }, status_rx: 422 }),
        ],
    });
    assert.deepEqual(result.turns, { modelTurns: 4, rawEmissions: 3, fenceFree: 1, fenceFreeAdmitted: 0, noOperation: 1 });
});

test("{§swebench-comparison} failed receipts preserve provenance and channels do not multiply failed executions", (t) => {
    const failure = { status_rx: 500, problem: { type: nonzero }, target: "sh:///process#stdout" };
    const row = trial(t, [{ id: 1, program: "```READ (sh:///process)```" }], [
        entry({ ...failure, ambient_event_id: 71 }),
        entry({ ...failure, origin: "_plurnk", target: "sh:///process#stderr" }),
        entry({ ...failure, origin: "_plurnk", target: "sh:///process#stdout" }),
        entry({ ...failure, origin: "_plurnk", ambient_event_id: 71 }),
        entry({ ...failure, inherited_history: true, ambient_event_id: 71 }),
        entry({ ...failure, origin: "_plurnk", inherited_history: true, ambient_event_id: 71 }),
        entry({ ...failure, origin: "_plurnk", target: "sh:///second#stdout" }),
        entry({ status_rx: 416, problem: { type: range }, target: "sh:///third#stdout" }),
        entry({ ...failure, origin: "_plurnk", target: null }),
        entry({ status_rx: 422, op: "EDIT", problem: { type: range } }),
    ]);
    assert.deepEqual(row.friction.failures, {
        receipts: { authored: { READ: 2, EDIT: 1 }, automatic: { READ: 4 }, ambient: { READ: 1 }, inherited: { READ: 2 }, unknown: {} },
        executionStreams: [{ path: "sh:///process", receipts: 6 }, { path: "sh:///second", receipts: 1 }],
        unaddressedExecutionReceipts: 1,
    });
});

test("{§swebench-comparison} absent evidence is unknown, while legacy receipts stay visible without guessed provenance", () => {
    assert.deepEqual(frictionOf(null), { turns: null, failures: null });
    assert.equal(frictionOf({ turn_attempts: [{}] }).turns, null);
    const legacy = frictionOf({
        turn_attempts: [{ turn_id: 1 }], turns: [{ id: 1, program: "hello" }],
        log_entries: [
            { origin: "model", op: "EDIT", status_rx: 422 },
            { origin: "_plurnk", op: "READ", status_rx: 500, target: "sh:///old#stdout", problem: { type: nonzero } },
            { inherited_history: false, origin: "_plurnk", op: "READ", status_rx: 500 },
            { inherited_history: true, origin: "model", op: "EDIT", status_rx: 422 },
        ],
    });
    assert.deepEqual(legacy.failures?.receipts, { authored: {}, automatic: {}, ambient: {}, inherited: { EDIT: 1 }, unknown: { EDIT: 1, READ: 2 } });
    assert.deepEqual(legacy.failures?.executionStreams, [{ path: "sh:///old", receipts: 1 }]);
    const withoutRows = frictionOf({ turn_attempts: [{ turn_id: 1 }], turns: [{ id: 1, program: "hello" }] });
    assert.deepEqual(withoutRows, { turns: { modelTurns: 1, rawEmissions: 1, fenceFree: 1, fenceFreeAdmitted: null, noOperation: null }, failures: null });
    const summary = summarizeFriction([legacy, withoutRows, frictionOf(null), legacy]);
    assert.equal(summary.turnTrials, 3);
    assert.equal(summary.failureTrials, 2);
    assert.equal(summary.turns?.noOperation, null, "missing outcomes cannot be counted as zero");
    assert.equal(summary.executionStreams, 2, "identical stream names in different trials are not one execution");
    assert.deepEqual(summary.receipts?.unknown, { EDIT: 2, READ: 4 });
    assert.equal(summarizeFriction([frictionOf(null)]).executionStreams, null);
});

test("{§swebench-comparison} missing inheritance provenance cannot prove absence of authored isolation escapes", (t) => {
    const row = trial(t, [{ id: 1, program: "hello" }], [entry({ inherited_history: undefined, target: "https://example.test" })]);
    assert.equal(row.webAttempts, null);
    assert.equal(row.webReads, null);
    assert.equal(row.mcpCalls, null);
});
}

// ─── plan.test.ts ───
{
test("{§swebench-comparison} a launch runs the corpus in order, drops --skip ids and what its halt policy let run on, and --limit bounds this launch", () => {
    const ids = corpusIds({ dataset: "SWE-bench/SWE-bench_Lite", ids: ["a", "b", "c", "d"] });
    assert.deepEqual(ids, ["a", "b", "c", "d"]);
    const trials = [
        "a\t1\t0\t/t/a\t/p/a\tpass",
        "b\t1\t1\t\t\tharness: rc=1, no trial directory",
        "c\t1\t0\t/t/c\t/p/c\tfail: reward 0",
        "d\t1\t0\t/t/d\t/p/d\tpass (turn ceiling exhausted)",
    ].join("\n") + "\n";
    const done = donePairs(trials, "pass");
    assert.deepEqual([...done], ["a\t1"], "under pass only a clean pass is done; whatever halted runs again unless its id is skipped");
    assert.deepEqual([...donePairs(trials, "clean")], ["a\t1", "c\t1", "d\t1"],
        "under clean every graded trial is done — a miss is the model's outcome — and an agent or harness verdict runs again");
    assert.deepEqual(planTrials({ ids, attempts: 1, limit: 0, only: [], skip: ["c"], done }), [{ id: "b", attempt: 1 }, { id: "d", attempt: 1 }]);
    assert.deepEqual(
        planTrials({ ids, attempts: 2, limit: 0, only: ["a", "b"], skip: [], done }),
        [{ id: "b", attempt: 1 }, { id: "a", attempt: 2 }, { id: "b", attempt: 2 }],
        "attempts are attempt-major, as the study's three rollouts per task",
    );
    assert.deepEqual(planTrials({ ids, attempts: 1, limit: 1, only: [], skip: [], done: new Set() }), [{ id: "a", attempt: 1 }], "--limit 1 is the pilot");
    assert.deepEqual(planTrials({ ids, attempts: 1, limit: 0, only: [], skip: ["c", "b"], done }), [{ id: "d", attempt: 1 }], "an accepted failure is a skip on every later launch");
    assert.deepEqual(planTrials({ ids, attempts: 1, limit: 0, only: [], skip: [], done: donePairs(trials, "clean") }), [{ id: "b", attempt: 1 }],
        "a three-attempt campaign resumed under clean re-buys only its harness-lost pair, never a graded miss");
    assert.throws(() => corpusIds({ dataset: "x" }), /corpus carries no ids/);
});
}

// ─── run.test.ts ───
{
test("{§swebench-evaluator} a graded trial publishes whatever the evaluator's exit; only an absent report is ungraded", () => {
    assert.deepEqual(gradingOutcome(1, null, true), { graded: true }, "a cleanup failure after the report is a diagnostic on the verdict, not a lost trial ({§swebench-evaluator})");
    assert.deepEqual(gradingOutcome(0, null, true), { graded: true });
    assert.deepEqual(gradingOutcome(1, null, false), { graded: false, reason: "the official evaluator exited 1 without a report" });
    assert.deepEqual(gradingOutcome(null, "SIGKILL", false), { graded: false, reason: "the official evaluator exited SIGKILL without a report" });
    assert.deepEqual(gradingOutcome(0, null, false), { graded: false, reason: "the official evaluator exited 0 without a report" }, "a clean exit without a report is still no grading");
});

test("{§swebench-evaluator} the candidate runs the ordinary client: --json, --yolo, the task prompt after --", () => {
    assert.deepEqual(candidateArgv("/runs/run1/repo", 1680, "Fix the missing-data crash", 100), [
        "plurnk",
        "--json",
        "--yolo",
        "--max-turns", "100",
        "--project-root", "/runs/run1/repo",
        "--timeout", "1680",
        "--", "Fix the missing-data crash",
    ]);
});

test("{§swebench-evaluator} the candidate approves locally without retired per-loop policy flags", () => {
    const argv = candidateArgv("/runs/run1/repo", -1, "task", 100);
    assert.ok(argv.includes("--yolo"), "the benchmark explicitly enables client approval");
    assert.ok(!argv.includes("--auto"));
    assert.ok(!argv.includes("--proposals"));
});

test("{§swebench-evaluator} -1 is the no-limit idiom: no --timeout flag is emitted", () => {
    assert.deepEqual(candidateArgv("/r", -1, "p", 100), [
        "plurnk", "--json", "--yolo",
        "--max-turns", "100", "--project-root", "/r", "--", "p",
    ]);
});

test("{§swebench-evaluator} the client's --json document is recovered from the candidate log", () => {
    const doc = JSON.stringify({ schemaVersion: 6, finalStatus: 200 });
    const log = ["digest: nothing", doc, "digest: done", ""].join("\n");
    assert.equal(extractPlurnkDoc(log), doc);
    assert.equal(extractPlurnkDoc("no json here\n"), null);
    assert.equal(extractPlurnkDoc('{"not":"a doc"}\n'), null);
});

test("{§swebench-evaluator} only a clean exit is a clean trial: a timeout, a spawn failure and a bad exit each say so", () => {
    const clean = { status: 0, signal: null, timedOut: false };
    assert.equal(exceptionInfo(clean, 1680), null);
    assert.equal(exceptionInfo({ ...clean, timedOut: true }, 1680)?.exception_type, "AgentTimeoutError");
    assert.match(String(exceptionInfo({ ...clean, timedOut: true }, 1680)?.exception_message), /1680s/);
    const spawnFailed = exceptionInfo({ status: null, signal: null, timedOut: false, error: new Error("spawn ENOENT") }, 1680);
    assert.equal(spawnFailed?.exception_type, "AgentSpawnError");
    assert.equal(spawnFailed?.exception_message, "spawn ENOENT");
    assert.equal(exceptionInfo({ status: 1, signal: null, timedOut: false }, 1680)?.exception_message, "the client exited 1");
    assert.equal(exceptionInfo({ status: null, signal: "SIGKILL", timedOut: false }, 1680)?.exception_message, "the client exited SIGKILL");
});

test("{§swebench-evaluator} the runner announces its trial before a prerequisite can fail", (t) => {
    const root = mkdtempSync(join(tmpdir(), "swebench-identity-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const result = spawnSync(process.execPath, [new URL("./run.ts", import.meta.url).pathname,
        "--instance", "mwaskom__seaborn-3010", "--model", "fixture"], {
        encoding: "utf8", timeout: 10_000,
        env: { ...process.env, PLURNK_BENCH_HOME: root, PLURNK_SWEBENCH_OPERATOR_ENV: join(root, "missing.env"),
            PLURNK_SWEBENCH_MIN_FREE_GB: "invalid" },
    });
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /PLURNK_SWEBENCH_MIN_FREE_GB must be a non-negative number/u);
    const artifact = result.stdout.match(/^artifact=(.+)$/mu)?.[1];
    assert.ok(artifact, result.stdout);
    assert.ok(artifact.startsWith(`${root}/`), result.stdout);
    assert.equal(existsSync(artifact), true);
});

test("{§swebench-evaluator} aborting a started process is cancellation, not spawn failure", { timeout: 10000 }, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "swebench-cancel-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const cancel = new AbortController();
    t.after(() => cancel.abort());
    const ready = watch(directory);
    const child = runToFiles(process.execPath, ["-e", 'require("node:fs").writeFileSync("ready", "started"); setInterval(() => {}, 1000);'], {
        cwd: directory, env: process.env, signal: cancel.signal,
        stdoutPath: join(directory, "out.log"), stderrPath: join(directory, "err.log"),
    });
    for await (const event of ready) {
        if (event.filename === "ready" && event.eventType === "change") break;
    }
    assert.equal(readFileSync(join(directory, "ready"), "utf8"), "started");
    cancel.abort(new Error("operator stopped this specimen"));
    const result = await child;
    assert.deepEqual(exceptionInfo(result, 10), {
        exception_type: "AgentCancelledError", exception_message: "operator stopped this specimen",
    });
    assert.equal(result.timedOut, false);
});

test("{§swebench-evaluator} the wrapper states the network bound and names neither an upstream fix, grading, a target, brevity nor grammar", () => {
    const statement = "When DEBUG is True, raising Http404 in a path converter does not help.";
    const wrapper = taskPrompt(statement).replace(statement, "");
    assert.match(wrapper, /no network access/iu, "the environment's bound is stated");
    assert.doesNotMatch(wrapper, /upstream|grading|graded|benchmark|swe-?bench/iu, "the wrapper never names an upstream fix, grading or the benchmark");
    assert.doesNotMatch(wrapper, /make .*pass|hidden[- ]tests?|reference[- ]patch|target/iu, "nor anything to aim at");
    assert.doesNotMatch(wrapper, /smallest|minimal|brief|concise/iu);
    for (const op of ["EDIT", "FIND", "READ", "SEND", "NOTE", "KILL", "backtick"]) {
        assert.ok(!wrapper.includes(op), `the task prompt must not teach ${op}`);
    }
});

test("{§swebench-evaluator} the official issue retains its internal whitespace, examples, and terminology", () => {
    const statement = "\n  A test of READ fails.\n\n```python\nassert compare(\"graded\", \"reference patch\")\n```\n\nKeep these  two spaces.\n";
    const prompt = taskPrompt(statement);
    assert.ok(prompt.includes(`<issue>\n${statement.trim()}\n</issue>`), "only outer whitespace may change");
});

test("{§swebench-comparison} the study's turn cap is the bound, not our wall clock", () => {
    const argv = candidateArgv("/r", 14400, "task", 100);
    assert.equal(argv[argv.indexOf("--max-turns") + 1], "100", "HarnessTax capped each attempt at 100 model turns");
    // The wall clock is a runaway guard: it must sit far above any plausible 100-turn rollout, or
    // a slow route records a timeout where the study would have recorded a turn count.
    assert.equal(argv[argv.indexOf("--timeout") + 1], "14400");
});
}

// ─── sample.test.ts ───
{
const ids = Array.from({ length: 20 }, (_, index) => `r${index % 4}__x-${index}`);
const repoOf = (id: string): string => id.split("__")[0]!;

test("{§swebench-evaluator} the draw order is deterministic for one seed and a permutation of the corpus", () => {
    assert.deepEqual(rankBySeed(ids, "a"), rankBySeed(ids, "a"));
    assert.notDeepEqual(rankBySeed(ids, "a"), rankBySeed(ids, "b"), "a different seed reorders the draw");
    assert.deepEqual([...rankBySeed(ids, "a")].sort(), [...ids].sort(), "no instance is invented or lost");
});

test("{§swebench-evaluator} a uniform draw returns exactly count distinct instances, sorted", () => {
    const draw = uniformDraw(ids, "s", 8);
    assert.equal(draw.length, 8);
    assert.equal(new Set(draw).size, 8);
    assert.deepEqual(draw, [...draw].sort());
});

test("{§swebench-evaluator} a stratified draw spreads across every repo before doubling up", () => {
    const draw = stratifiedDraw(ids, repoOf, "s", 8);
    assert.equal(draw.length, 8);
    assert.deepEqual(Object.values(repoCounts(draw, repoOf)), [2, 2, 2, 2], "eight across four repos is two each");
});

test("{§swebench-evaluator} a cited corpus is taken verbatim and sorted, never drawn", () => {
    const known = new Set(ids);
    const tasks = [{ instance_id: ids[7]! }, { instance_id: ids[2]! }, { instance_id: ids[19]! }];
    const cited = citedInstances(tasks, known);
    assert.deepEqual(cited, [ids[7]!, ids[2]!, ids[19]!].toSorted(), "every named id, in sorted order");
    assert.deepEqual(citedInstances(tasks, known), cited, "no seed, so no run-to-run drift");
});

test("{§swebench-evaluator} a citation the split cannot satisfy is refused, never silently shortened", () => {
    const known = new Set(ids);
    assert.throws(
        () => citedInstances([{ instance_id: ids[0]! }, { instance_id: "django__django-99999" }], known),
        /cited instances absent from the dataset: django__django-99999/u,
        "a stale citation must not run as 1 of 2",
    );
    assert.throws(
        () => citedInstances([{ instance_id: ids[0]! }, { instance_id: ids[0]! }], known),
        /cited corpus repeats r0__x-0/u,
        "a repeated id would silently shrink the corpus",
    );
});
}
