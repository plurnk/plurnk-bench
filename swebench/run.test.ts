import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateArgv, exceptionInfo, extractPlurnkDoc, runToFiles, taskPrompt } from "./run.ts";

test("[§swebench] the candidate runs the ordinary client: --json, --yolo, the task prompt after --", () => {
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

test("{§swebench-conditions} the candidate approves locally without retired per-loop policy flags", () => {
    const argv = candidateArgv("/runs/run1/repo", -1, "task", 100);
    assert.ok(argv.includes("--yolo"), "the benchmark explicitly enables client approval");
    assert.ok(!argv.includes("--auto"));
    assert.ok(!argv.includes("--proposals"));
});

test("[§swebench] -1 is the no-limit idiom: no --timeout flag is emitted", () => {
    assert.deepEqual(candidateArgv("/r", -1, "p", 100), [
        "plurnk", "--json", "--yolo",
        "--max-turns", "100", "--project-root", "/r", "--", "p",
    ]);
});

test("[§swebench] the client's --json document is recovered from the candidate log", () => {
    const doc = JSON.stringify({ schemaVersion: 6, finalStatus: 200 });
    const log = ["digest: nothing", doc, "digest: done", ""].join("\n");
    assert.equal(extractPlurnkDoc(log), doc);
    assert.equal(extractPlurnkDoc("no json here\n"), null);
    assert.equal(extractPlurnkDoc('{"not":"a doc"}\n'), null);
});

test("[§swebench-trial] only a clean exit is a clean trial: a timeout, a spawn failure and a bad exit each say so", () => {
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

test("{§swebench-trial} the runner announces its trial before a prerequisite can fail", (t) => {
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

test("{§swebench-trial} aborting a started process is cancellation, not spawn failure", { timeout: 10000 }, async (t) => {
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

test("[§swebench-prompt] the task prompt requests a repository fix and verification without grading or grammar coaching", () => {
    const statement = "When DEBUG is True, raising Http404 in a path converter does not help.";
    const prompt = taskPrompt(statement);
    assert.match(prompt, /^Fix the following issue in the checked-out repository\./u);
    assert.ok(prompt.endsWith("Implement the fix in the working tree and verify the affected behavior.\nThis environment has no network access: the repository and its installed dependencies are all that is available."));
    const wrapper = prompt.replace(statement, "");
    assert.doesNotMatch(wrapper, /grad(?:e|ed|ing)|hidden[- ]tests?|reference[- ]patch/iu);
    assert.doesNotMatch(wrapper, /smallest|minimal|brief|concise/iu);
    for (const op of ["EDIT", "FIND", "READ", "SEND", "NOTE", "KILL", "backtick"]) {
        assert.ok(!wrapper.includes(op), `the task prompt must not teach ${op}`);
    }
});

test("[§swebench-prompt] the official issue retains its internal whitespace, examples, and terminology", () => {
    const statement = "\n  A test of READ fails.\n\n```python\nassert compare(\"graded\", \"reference patch\")\n```\n\nKeep these  two spaces.\n";
    const prompt = taskPrompt(statement);
    assert.ok(prompt.includes(`<issue>\n${statement.trim()}\n</issue>`), "only outer whitespace may change");
});

test("[§swebench-profiles] the study's turn cap is the bound, not our wall clock", () => {
    const argv = candidateArgv("/r", 14400, "task", 100);
    assert.equal(argv[argv.indexOf("--max-turns") + 1], "100", "HarnessTax capped each attempt at 100 model turns");
    // The wall clock is a runaway guard: it must sit far above any plausible 100-turn rollout, or
    // a slow route records a timeout where the study would have recorded a turn count.
    assert.equal(argv[argv.indexOf("--timeout") + 1], "14400");
});
