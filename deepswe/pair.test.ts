// {§pair-sheet} — the sheet over both harnesses' result shapes; absence stays absent.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EMPTY_SHA256 } from "./benchlet.ts";
import {
    ROUTES_PATH,
    agentBudgetSeconds,
    readMiniSide,
    readPlurnkSide,
    readRoutes,
    renderSheet,
    routeFor,
    writeSheet,
    type PairRecord,
} from "./pair.ts";

const TRAJECTORY = resolve(import.meta.dirname, "fixtures/mini-trajectory.sample.json");

const record = (overrides: Partial<PairRecord> = {}): PairRecord => ({
    schemaVersion: 1,
    task: "koota-entity-snapshot-rollback",
    alias: "dumbox",
    route: { model: "openai/accounts/fireworks/models/glm-5p3-flash", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", reasoningEffort: "medium" },
    budgetSeconds: 5400,
    candidateTimeoutSeconds: 5280,
    startedAt: "2026-09-11T20:00:00.000Z",
    plurnk: { skipped: false, command: ["deepswe/benchlet.sh", "--task", "koota-entity-snapshot-rollback"] },
    mini: { skipped: false, command: ["pier", "run"] },
    ...overrides,
});

const plurnkResult = {
    schemaVersion: 2,
    harnessStatus: "complete",
    totalCostUsd: "0.61",
    candidate: { status: 0, signal: null, timedOut: false, error: null, startedAt: "2026-09-11T20:05:00.000Z", completedAt: "2026-09-11T20:17:03.000Z", durationMs: 723_000 },
    summary: {
        modelTurns: 31, providerRequests: 34, rejectedEmissions: 2, models: ["accounts/fireworks/models/glm-5p3-flash"],
        usage: { inputTokens: 1_204_311, outputTokens: 18_204, totalTokens: 1_222_515, inputTokenDetails: { cacheReadTokens: 1_100_000 } },
        costUsd: "0.42",
        loopOutcomes: [{ workerId: 1, workerName: "root", loop: 1, status: 200, terminalMessage: "Implemented snapshot rollback; tests pass.", terminatedBy: null, problem: null }],
        operationCounts: { READ: 12, EDIT: 9, EXEC: 8, TASK: 1 },
    },
    oracle: { submission: { applyFailed: false, reward: 1, p2pPassed: 47, p2pTotal: 47, f2pPassed: 84, f2pTotal: 84, partial: 1, tests: [] } },
    startedAt: "2026-09-11T20:00:10.000Z",
    completedAt: "2026-09-11T20:24:40.000Z",
    durationMs: 1_470_000,
};

const miniResult = {
    exception_info: null,
    agent_info: { name: "mini-swe-agent", version: "2.4.6", model_info: { name: "accounts/fireworks/models/glm-5p3-flash", provider: "openai" } },
    agent_result: { n_input_tokens: 6_384_114, n_cache_tokens: 6_160_384, n_output_tokens: 41_933, cost_usd: null, n_agent_steps: 96 },
    verifier_result: { rewards: { reward: 0, f2p_total: 84, f2p_passed: 83, p2p_total: 47, p2p_passed: 47, f2p: 0.988, p2p: 1, partial: 0.9923664122137404 } },
    started_at: "2026-09-08T15:16:56.803531Z",
    finished_at: "2026-09-08T15:31:13.550871Z",
    agent_execution: { started_at: "2026-09-08T15:17:11.148078Z", finished_at: "2026-09-08T15:30:46.056379Z" },
};

const pairDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "bench-pair-"));
    writeFileSync(join(dir, "pair.json"), JSON.stringify(record()));
    return dir;
};

const writePlurnk = (dir: string, result: unknown, run = "run1-deepswe-koota-entity-snapshot-rollback-dumbox"): void => {
    mkdirSync(join(dir, "plurnk", run), { recursive: true });
    writeFileSync(join(dir, "plurnk", run, "result.json"), JSON.stringify(result));
};

const writeMini = (dir: string, result: unknown, trajectory = true): string => {
    const trial = join(dir, "mini", "koota-entity-snapshot-rollback__y3vXVoY");
    mkdirSync(join(trial, "agent"), { recursive: true });
    writeFileSync(join(dir, "mini", "result.json"), "{}");
    writeFileSync(join(trial, "result.json"), JSON.stringify(result));
    if (trajectory) copyFileSync(TRAJECTORY, join(trial, "agent", "mini-swe-agent.trajectory.json"));
    return trial;
};

test("[§pair-sheet] the committed alias map names a complete mini route per alias; an unknown alias is refused by name", () => {
    const routes = readRoutes(ROUTES_PATH);
    assert.deepEqual(routeFor(routes, "dumbox"), { model: "openai/accounts/fireworks/models/glm-5p3-flash", baseUrl: "https://api.fireworks.ai/inference/v1", keyEnv: "FIREWORKS_API_KEY", reasoningEffort: "medium" });
    assert.throws(() => routeFor(routes, "nope"), { message: "pair has no mini-swe-agent route for alias nope; add one to deepswe/pair.aliases.json" });
    const broken = join(mkdtempSync(join(tmpdir(), "bench-pair-routes-")), "routes.json");
    writeFileSync(broken, JSON.stringify({ x: { model: "m", baseUrl: "u", keyEnv: "", reasoningEffort: "low" } }));
    assert.throws(() => readRoutes(broken), { name: "TypeError", message: `${broken}: alias x needs model, baseUrl, keyEnv and reasoningEffort strings` });
});

test("[§pair-sheet] the task budget is read from [agent], not the verifier's timeout", () => {
    const toml = "[verifier]\ntimeout_sec = 1800.0\n\n[agent]\nnetwork_mode = \"no-network\"\ntimeout_sec = 5400.0\n[environment]\nbuild_timeout_sec = 1800.0\n";
    assert.equal(agentBudgetSeconds(toml), 5400);
    assert.equal(agentBudgetSeconds("[verifier]\ntimeout_sec = 1800.0\n"), null);
});

test("[§pair-sheet] both sides read into one fact shape; PAIR.md carries both verdicts and names no winner", () => {
    const dir = pairDir();
    try {
        writePlurnk(dir, plurnkResult);
        const trial = writeMini(dir, miniResult);
        const { plurnk, mini } = writeSheet(dir);
        assert.equal(plurnk.state, "complete");
        assert.deepEqual(plurnk.oracle, { reward: 1, f2pPassed: 84, f2pTotal: 84, p2pPassed: 47, p2pTotal: 47, partial: 1 });
        assert.deepEqual(plurnk.tokens, { input: 1_204_311, cached: 1_100_000, output: 18_204 });
        assert.equal(plurnk.costUsd, "0.42", "the candidate model's cost, not the requiem-inclusive total");
        assert.equal(plurnk.agentSeconds, 723);
        assert.equal(plurnk.totalSeconds, 1470);
        assert.equal(plurnk.exit, "200 Implemented snapshot rollback; tests pass.");
        assert.equal(mini.state, "complete");
        assert.deepEqual(mini.oracle, { reward: 0, f2pPassed: 83, f2pTotal: 84, p2pPassed: 47, p2pTotal: 47, partial: 0.9923664122137404 });
        assert.equal(mini.steps, 96);
        assert.equal(mini.requests, 3, "provider requests come from the trajectory's responses");
        assert.equal(mini.costUsd, null, "a null cost stays absent");
        assert.equal(mini.exit, "Submitted");
        assert.ok(Math.abs((mini.agentSeconds ?? 0) - 814.9) < 0.1);
        // {§pair-mini-digest} — the trial gets its digest where the plurnk run keeps its own.
        assert.ok(existsSync(join(trial, "digest", "steps.md")) && existsSync(join(trial, "digest", "steps.json")));
        const sheet = readFileSync(join(dir, "PAIR.md"), "utf8");
        assert.match(sheet, /^# koota-entity-snapshot-rollback · dumbox\n/);
        assert.match(sheet, /\| reward \| 1 \| 0 \|/);
        assert.match(sheet, /\| f2p passed \| 84\/84 \| 83\/84 \|/);
        assert.match(sheet, /\| cost USD \| 0\.42 \| absent \|/);
        assert.match(sheet, /\| agent wall time \| 12 m 03 s \| 13 m 35 s \|/);
        assert.match(sheet, /\| steps \| 31 turns \| 96 steps \|/);
        assert.doesNotMatch(sheet, /win|better|worse|beats/iu, "facts only");
        assert.ok(existsSync(join(dir, "facts.json")));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("[§pair-sheet] a side that did not run or did not finish is written as absent or failed, never graded", () => {
    const dir = pairDir();
    try {
        assert.deepEqual([readPlurnkSide(dir).state, readMiniSide(dir).state], ["absent", "absent"]);
        writePlurnk(dir, { schemaVersion: 2, harnessStatus: "infrastructure_error", infrastructure: { stage: "candidate", message: "candidate did not produce a digest" }, startedAt: null, completedAt: "2026-09-11T20:01:00.000Z", durationMs: null });
        const plurnk = readPlurnkSide(dir);
        assert.equal(plurnk.state, "failed");
        assert.equal(plurnk.note, "candidate: candidate did not produce a digest");
        assert.equal(plurnk.oracle, null);
        writeMini(dir, { ...miniResult, verifier_result: null, exception_info: { type: "AgentTimeoutError" } }, false);
        const mini = readMiniSide(dir);
        assert.equal(mini.state, "failed");
        assert.equal(mini.note, "{\"type\":\"AgentTimeoutError\"}");
        assert.equal(mini.model, "accounts/fireworks/models/glm-5p3-flash");
        const sheet = renderSheet(record({ mini: { skipped: true, command: null } }), plurnk, mini);
        assert.match(sheet, /\| state \| failed \| failed \|/);
        assert.match(sheet, /\| reward \| absent \| absent \|/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("[§pair-sheet] a pair holds exactly one run per side", () => {
    const dir = pairDir();
    try {
        writePlurnk(dir, plurnkResult, "run1-deepswe-x-dumbox");
        writePlurnk(dir, plurnkResult, "run2-deepswe-x-dumbox");
        assert.throws(() => readPlurnkSide(dir), { message: /a pair holds one benchlet run, found 2/ });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// {§benchlet-candidate-exit} (#41) — the sheet must not present a killed, patchless run as an
// ordinary near-miss. Three dumbox-20260918 runs read as clean 0/N failures when the provider had
// cut them off at 600 s before the model issued a single edit.
test("[§pair-sheet] a candidate the clock killed without a patch says both, beside its oracle", () => {
    const dir = pairDir();
    try {
        writePlurnk(dir, {
            ...plurnkResult,
            harnessStatus: "candidate_failed",
            candidate: { ...plurnkResult.candidate, outcome: "timeout", timedOut: true },
            oracle: {
                submission: { applyFailed: false, reward: 0, p2pPassed: 47, p2pTotal: 47, f2pPassed: 0, f2pTotal: 84, partial: 0, tests: [] },
                submissionEvidence: { reusedWorking: false, patchSha256: EMPTY_SHA256, emptyPatch: true },
            },
        });
        const plurnk = readPlurnkSide(dir);
        assert.equal(plurnk.state, "complete", "the run happened and the oracle graded it; that is not in dispute");
        assert.match(String(plurnk.note), /candidate timed out/);
        assert.match(String(plurnk.note), /produced no patch/, "the loss names its own cause");
        assert.match(String(plurnk.note), /harness status candidate_failed/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
