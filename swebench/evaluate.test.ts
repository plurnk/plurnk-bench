import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSystemErrorName } from "node:util";
import test, { type TestContext } from "node:test";
import { readTrialRow, render, summarize, verdictOf } from "./report.ts";
import { donePairs } from "./plan.ts";

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
