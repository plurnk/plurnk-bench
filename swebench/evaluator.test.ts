import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { aggregateReportPath, emptyPatchReward, evaluationRunId, instanceReportPath, predictionsJsonl, rewardFromInstanceReport, type SweInstanceReport } from "./evaluator.ts";
import { joinRecord, type PlurnkDoc } from "../src/ingest.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { modelHosts, runContainer, type ContainerRequest } from "./container.ts";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getSystemErrorName, parseEnv } from "node:util";
import { readTrialRow, render, summarize, verdictOf } from "./report.ts";
import { donePairs } from "./plan.ts";
import { plurnkEnvironment } from "./runtime.ts";

// ─── evaluator.test.ts ───
{
// The real Phase-0 preflight verdict (gold patch, mwaskom__seaborn-3010).
const RESOLVED: SweInstanceReport = {
    patch_is_None: false,
    patch_exists: true,
    patch_successfully_applied: true,
    resolved: true,
    infra_failure: false,
    tests_status: {
        FAIL_TO_PASS: { success: ["tests/_stats/test_regression.py::TestPolyFit::test_missing_data"], failure: [] },
        PASS_TO_PASS: {
            success: [
                "tests/_stats/test_regression.py::TestPolyFit::test_no_grouper",
                "tests/_stats/test_regression.py::TestPolyFit::test_one_grouper",
            ],
            failure: [],
        },
    },
};

test("{§swebench-evaluator} a resolved instance is reward 1 with f2p/p2p counts and a full partial", () => {
    assert.deepEqual(rewardFromInstanceReport(RESOLVED), {
        reward: 1,
        partial: 1,
        f2p_total: 1,
        f2p_passed: 1,
        p2p_total: 2,
        p2p_passed: 2,
    });
});

test("{§swebench-evaluator} a non-resolved instance is reward 0 and never invents a pass", () => {
    const reward = rewardFromInstanceReport({
        ...RESOLVED,
        resolved: false,
        tests_status: {
            FAIL_TO_PASS: { success: [], failure: ["tests/x.py::test_y"] },
            PASS_TO_PASS: { success: ["tests/x.py::test_z"], failure: [] },
        },
    });
    assert.equal(reward?.reward, 0);
    assert.equal(reward?.f2p_total, 1);
    assert.equal(reward?.f2p_passed, 0);
    assert.equal(reward?.partial, 0.5);
});

test("{§swebench-evaluator} absence and infrastructure failure are the same honest null, never 0", () => {
    assert.equal(rewardFromInstanceReport(null), null);
    assert.equal(rewardFromInstanceReport(undefined), null);
    assert.equal(rewardFromInstanceReport({ ...RESOLVED, infra_failure: true }), null);
});

test("{§swebench-evaluator} a patch that failed to apply is recorded, not silently graded", () => {
    const reward = rewardFromInstanceReport({ ...RESOLVED, resolved: false, patch_successfully_applied: false });
    assert.equal(reward?.reward, 0);
    assert.equal(reward?.apply_failed, 1);
});

test("{§swebench-evaluator} the oracle join flows through the shared core to a BenchRecord verdict", () => {
    const doc: PlurnkDoc = {
        schemaVersion: 6,
        finalStatus: 200,
        workspace: { id: 1, name: "bench" },
        sessionId: 7,
        loopId: 9,
        turnCount: 3,
        wallMs: 1234,
    };
    const record = joinRecord({
        harness: "swebench",
        taskId: "mwaskom__seaborn-3010",
        model: "luna",
        doc,
        reward: rewardFromInstanceReport(RESOLVED),
        dbPath: "/tmp/plurnk.db",
    });
    assert.equal(record.outcome, "pass");
    assert.equal(record.reward, 1);
    assert.equal(record.p2pRegressed, false);
    assert.equal(record.turns, 3);
});

test("{§swebench-evaluator} report paths follow the harness's own layout", () => {
    assert.equal(aggregateReportPath("/r", "run1", "gold"), "/r/gold.run1.json");
    assert.equal(
        instanceReportPath("/r", "run1", "gold", "mwaskom__seaborn-3010"),
        "/r/logs/run_evaluation/run1/gold/mwaskom__seaborn-3010/report.json",
    );
});

test("{§swebench-evaluator} predictions serialize one JSON object per line", () => {
    assert.equal(
        predictionsJsonl([{ instance_id: "i", model_name_or_path: "gold", model_patch: "diff" }]),
        '{"instance_id":"i","model_name_or_path":"gold","model_patch":"diff"}\n',
    );
    assert.equal(predictionsJsonl([]), "");
});

test("{§swebench-evaluator} a candidate that produced no patch scores zero, not an infrastructure failure", () => {
    // The official harness filters an empty prediction out of its dataset and writes no report,
    // so the run would otherwise join as `error` — an absent oracle — instead of the loss it is (#40).
    assert.deepEqual(emptyPatchReward(), { reward: 0, empty_patch: 1 });
    const record = joinRecord({
        harness: "swebench",
        taskId: "mwaskom__seaborn-3010",
        model: "luna",
        doc: { schemaVersion: 6, finalStatus: 200, turnCount: 2 },
        reward: emptyPatchReward(),
        dbPath: "/tmp/plurnk.db",
    });
    assert.equal(record.outcome, "fail", "an empty patch is a graded loss, never an absent oracle");
    assert.equal(record.reward, 0);
});

test("{§swebench-evaluator} each attempt at one instance gets its own container-safe run id", () => {
    const instance = "mwaskom__seaborn-3010";
    const ids = new Set(Array.from({ length: 16 }, () => evaluationRunId(instance)));
    assert.equal(ids.size, 16, "two parallel attempts must not share sweb.eval.<instance>.<run_id>");
    for (const id of ids) {
        assert.ok(id.startsWith(`swebench-${instance}-`), id);
        assert.match(id, /^[A-Za-z0-9_.-]+$/, "a run id becomes a Docker container name verbatim");
    }
});
}

// ─── container.test.ts ───
{
test("{§swebench-evaluator} egress is explicit, with no-network valid only for preflight", () => {
    assert.deepEqual(modelHosts({}, true), []);
    assert.throws(() => modelHosts({}, false), /model endpoint/);
    assert.deepEqual(modelHosts({ PLURNK_SWEBENCH_MODEL_HOSTS: '["api.example.com"]' }, false), ["api.example.com"]);
    for (const value of ['["https://api.example.com"]', '"public"', '[""]', '[3]']) {
        assert.throws(() => modelHosts({ PLURNK_SWEBENCH_MODEL_HOSTS: value }, false), /host names/);
    }
});

test("{§swebench-evaluator} cancellation does not interrupt draining a second time at the wall-clock deadline", { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "candidate-drain-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "fixture.mjs");
    await writeFile(executable, `#!/usr/bin/env node
let input = "";
for await (const part of process.stdin) input += part;
const {trial} = JSON.parse(input);
const {writeFileSync} = await import("node:fs");
let signals = 0;
process.on("SIGTERM", () => {
    signals++;
    setTimeout(() => {console.log("signals=" + signals); process.exit(143);}, 600);
});
writeFileSync(trial + "/ready", "ready");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const controller = new AbortController();
    const request: ContainerRequest = { trial: root, runtime: root, repository: root, agent: root,
        image: "fixture", cpus: 1, memoryMb: 512, allowedHosts: ["provider.example"],
        preflight: false, argv: ["plurnk"], env: {} };
    const result = runContainer(request, { python: executable, signal: controller.signal, timeoutMs: 500 });
    for (;;) {
        try { await readFile(join(root, "ready")); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await setTimeout(10, undefined, { signal: t.signal });
    }
    controller.abort();
    const exited = await result;
    assert.equal(exited.status, 143);
    assert.equal(exited.cancelled, true);
    assert.equal(exited.timedOut, false);
    assert.equal(await readFile(join(root, "container.stdout.log"), "utf8"), "signals=1\n");
});

test("{§swebench-evaluator} credentials cross stdin, not files or process arguments", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "candidate-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "fixture.mjs");
    await writeFile(executable, `#!/usr/bin/env node
let input = "";
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
if (request.env.PROVIDER_API_KEY !== "fixture-secret") process.exit(5);
if (process.argv.some((arg) => arg.includes("fixture-secret"))) process.exit(6);
if (request.resolverConfig !== "/configured/resolv.conf") process.exit(7);
console.log("received through stdin");
`, { mode: 0o755 });
    const request: ContainerRequest = { trial: root, runtime: root, repository: root, agent: root,
        image: "fixture", cpus: 1, memoryMb: 512, allowedHosts: ["provider.example"],
        preflight: false, argv: ["plurnk"], env: { PROVIDER_API_KEY: "fixture-secret" } };
    const result = await runContainer(request, { python: executable, resolverConfig: "/configured/resolv.conf" });
    assert.equal(result.status, 0);
    assert.equal(await readFile(join(root, "container.stdout.log"), "utf8"), "received through stdin\n");
    assert.equal(await readFile(join(root, "container.stderr.log"), "utf8"), "");
});
}

// ─── evaluate.test.ts ───
{
const here = dirname(fileURLToPath(import.meta.url));
const instance = "mwaskom__seaborn-3010";
const setup = (t: TestContext) => {
    const root = mkdtempSync(join(tmpdir(), "swebench-evaluation-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const python = join(root, "evaluator");
    copyFileSync(join(here, "fixtures", "evaluator.mjs"), python);
    chmodSync(python, 0o755);
    const patch = join(root, "artifacts", "model.patch");
    mkdirSync(dirname(patch), { recursive: true });
    writeFileSync(patch, "diff --git a/file.py b/file.py\n+fixed\n");
    mkdirSync(join(root, "agent"));
    writeFileSync(join(root, "agent", "plurnk.json"), JSON.stringify({ schemaVersion: 6, finalStatus: 200, wallMs: 10 }));
    writeFileSync(join(root, "result.json"), JSON.stringify({ trial_name: "fixture", task_name: instance, exception_info: null }));
    const run = (scenario: string) => spawnSync(process.execPath, [join(here, "evaluate.ts"), "--instance", instance,
        "--patch", patch, "--out", root, "--label", "plurnk"], {
        encoding: "utf8", timeout: 15_000,
        env: { ...process.env, PLURNK_SWEBENCH_PYTHON: python, TEST_EVALUATOR_SCENARIO: scenario },
    });
    const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));
    return { root, patch, python, run, json };
};

test("{§swebench-evaluator} the exact instance verdict survives a subsequent Docker summary race", (t) => {
    const trial = setup(t);
    const result = trial.run("housekeeping");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /404 No such container/u);
    assert.ok(existsSync(join(trial.root, "verifier", "reward.json")), "a saved oracle verdict must survive the evaluator's later error");
    assert.equal(trial.json("verifier/reward.json").reward, 1);
    const attempt = trial.json("verifier/evaluation.json");
    assert.equal(attempt.state, "finished");
    assert.equal(attempt.exitCode, 1);
    assert.equal(attempt.reward.reward, 1);
    assert.match(readFileSync(join(trial.root, "oracle", attempt.runId, "stderr.log"), "utf8"), /404 No such container/u);
    assert.match(verdictOf(trial.root), /^pass \(evaluator: official evaluator exited 1\)$/u);
    const row = `${instance}\t1\t1\t${trial.root}\t\tharness: old grading failure\n`;
    assert.throws(() => donePairs(row, "pass"), /retry swebench\/evaluate.ts/u);
    assert.deepEqual([...donePairs(row, "clean")], [`${instance}\t1`], "a policy accepting saved verdicts need not regrade or buy inference");
    assert.deepEqual([...donePairs(row, "pass", { skip: [instance] })], [`${instance}\t1`]);
    assert.deepEqual([...donePairs(row, "pass", { only: ["another-specimen"] })], []);
    const report = readTrialRow(trial.root, 1)!;
    assert.equal(report.evaluation?.exitCode, 1);
    assert.equal(report.exception, null, "grading failure must not replace the candidate's own exit record");
    assert.equal(report.reward, 1);
    assert.match(render({}, [report], summarize([report])), /evaluator evidence: 1\/1 trials; latest attempts with problems: 1/u);
});

for (const scenario of ["missing", "malformed", "wrong-instance", "infrastructure", "incomplete"]) {
    test(`{§swebench-evaluator} ${scenario} reports do not invent a verdict`, (t) => {
        const trial = setup(t);
        const result = trial.run(scenario);
        assert.equal(result.status, 1, result.stdout);
        assert.equal(existsSync(join(trial.root, "verifier", "reward.json")), false);
        assert.equal(trial.json("verifier/evaluation.json").reward, null);
        assert.match(verdictOf(trial.root), /^harness: evaluator:/u);
    });
}

test("{§swebench-evaluator} evaluator-only retry preserves prior attempts and rejects a different candidate", (t) => {
    const trial = setup(t);
    assert.equal(trial.run("housekeeping").status, 1);
    const first = trial.json("verifier/evaluation.json");
    const original = readFileSync(join(trial.root, "oracle", first.runId, "evaluation.json"), "utf8");
    assert.equal(trial.run("pass").status, 0);
    const second = trial.json("verifier/evaluation.json");
    assert.notEqual(first.runId, second.runId);
    assert.equal(first.patchSha256, second.patchSha256);
    assert.equal(readFileSync(join(trial.root, "oracle", first.runId, "evaluation.json"), "utf8"), original);
    assert.equal(verdictOf(trial.root), "pass");
    assert.deepEqual([...donePairs(`${instance}\t1\t1\t${trial.root}\t\tharness: old failure\n`, "pass")], [`${instance}\t1`],
        "resume reads the recovered verdict without rewriting the original launch record");
    writeFileSync(trial.patch, "a different patch");
    const rejected = trial.run("pass");
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /different candidate/u);
    assert.equal(trial.json("verifier/evaluation.json").runId, second.runId);
    assert.equal(readdirSync(join(trial.root, "oracle")).length, 2);
});

test("{§swebench-evaluator} an ordinary miss is scored without an evaluator exception", (t) => {
    const trial = setup(t);
    const result = trial.run("miss");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(trial.json("verifier/reward.json").reward, 0);
    assert.deepEqual(trial.json("verifier/evaluation.json").diagnostics, []);
    assert.equal(verdictOf(trial.root), "fail: reward 0");
});

test("{§swebench-evaluator} a failed reevaluation cannot erase a valid verdict for the same patch", (t) => {
    const trial = setup(t);
    assert.equal(trial.run("pass").status, 0);
    assert.equal(trial.run("missing").status, 1);
    assert.equal(trial.json("verifier/reward.json").reward, 1);
    assert.equal(trial.json("verifier/evaluation.json").reward, null);
    assert.match(verdictOf(trial.root), /^pass \(evaluator: official evaluator exited 1;/u);
});

test("{§swebench-evaluator} empty patches are scored without spawning the oracle", (t) => {
    const trial = setup(t);
    writeFileSync(trial.patch, "\n");
    const result = trial.run("housekeeping");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /instance evaluation finished/u);
    assert.deepEqual(trial.json("verifier/reward.json"), { reward: 0, empty_patch: 1 });
    assert.deepEqual(trial.json("verifier/evaluation.json").diagnostics, []);
});

test("{§swebench-evaluator} an evaluator spawn failure retains its cause and no verdict", (t) => {
    const trial = setup(t);
    chmodSync(trial.python, 0o600);
    const result = trial.run("pass");
    assert.equal(result.status, 1);
    const attempt = trial.json("verifier/evaluation.json");
    assert.equal(attempt.state, "finished");
    assert.equal(getSystemErrorName(attempt.exitCode), "EACCES");
    assert.match(attempt.diagnostics[0], /EACCES/u);
    assert.equal(attempt.reward, null);
});
}

// ─── runtime.test.ts ───
{
const root = resolve(import.meta.dirname, "..");

test("{§swebench-evaluator} the benchmark's server approval policy reaches every candidate session", async () => {
    const defaults = parseEnv(readFileSync(resolve(root, ".env.defaults"), "utf8"));
    assert.equal(defaults.PLURNK_SERVICE_PROPOSALS, "accept");
    const env = await plurnkEnvironment(root, "deepseek/deepseek-chat", defaults);
    assert.equal(env.PLURNK_SERVICE_PROPOSALS, "accept");
});

test("{§swebench-evaluator} the candidate inherits route tuning and only its provider's credentials", async () => {
    const env = {
        PLURNK_MODEL: "unrelated",
        PLURNK_MODEL_trial: "deepseek/deepseek-chat",
        PLURNK_PROVIDERS_EFFORT_trial: "high",
        PLURNK_BASEURL_trial: "https://provider.example/v1",
        DEEPSEEK_BASE_URL: "https://provider.example/fallback",
        DEEPSEEK_API_KEY: "selected-fixture-key",
        UNRELATED_API_KEY: "unrelated-fixture-key",
        HOME: "/host-home",
        PATH: "/host-bin",
        NODE_OPTIONS: "--import=/host-injection.mjs",
    };
    assert.deepEqual(await plurnkEnvironment(root, "trial", env), {
        PLURNK_MODEL: "trial", PLURNK_MODEL_trial: env.PLURNK_MODEL_trial,
        PLURNK_PROVIDERS_EFFORT_trial: "high", PLURNK_BASEURL_trial: env.PLURNK_BASEURL_trial,
        DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    });
});

test("{§swebench-evaluator} an operator-declared credential name replaces catalog names without copying it to a file", async () => {
    const env = {
        PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_API_KEY_ENV: " TEAM_MODEL_KEY ",
        TEAM_MODEL_KEY: "selected-fixture-key", DEEPSEEK_API_KEY: "unused-fixture-key",
    };
    assert.deepEqual(await plurnkEnvironment(root, "deepseek/deepseek-chat", env), {
        PLURNK_MODEL: "deepseek/deepseek-chat",
        PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_API_KEY_ENV: env.PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_API_KEY_ENV,
        TEAM_MODEL_KEY: env.TEAM_MODEL_KEY,
    });
});
}
