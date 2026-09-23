import test from "node:test";
import assert from "node:assert/strict";
import { candidateArgv, exceptionInfo, extractPlurnkDoc, taskPrompt } from "./run.ts";

test("[§swebench] the candidate runs the ordinary client: --json, --auto, the task prompt after --", () => {
    assert.deepEqual(candidateArgv("/runs/run1/repo", 1680, "Fix the missing-data crash", 100), [
        "scripts/candidate.mjs",
        "--json",
        "--auto",
        "--proposals", "accept",
        "--max-turns", "100",
        "--project-root", "/runs/run1/repo",
        "--timeout", "1680",
        "--", "Fix the missing-data crash",
    ]);
});

test("[§swebench-conditions] the candidate states a proposal disposition, or it cannot edit at all", () => {
    const argv = candidateArgv("/runs/run1/repo", -1, "task", 100);
    // --auto is attendance, not disposition. Without an explicit accept the loop is unattended
    // and every EDIT is refused no_review_channel against the shipped reject (plurnk-bench#42).
    const disposition = argv[argv.indexOf("--proposals") + 1];
    assert.equal(disposition, "accept", "an unattended loop with no stated disposition cannot change a file");
    assert.ok(argv.includes("--auto"), "attendance is still stated");
});

test("[§swebench] -1 is the no-limit idiom: no --timeout flag is emitted", () => {
    assert.deepEqual(candidateArgv("/r", -1, "p", 100), [
        "scripts/candidate.mjs", "--json", "--auto", "--proposals", "accept",
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

test("[§swebench-prompt] the task prompt keeps the official shape and names the agentic deliverable", () => {
    const statement = "  When DEBUG is True, raising Http404 in a path converter does not help.  ";
    const prompt = taskPrompt(statement);
    // The official style-3 shape: premise, the issue delimited, then the deliverable.
    assert.match(prompt, /^You will be provided with an issue statement explaining a problem to resolve\./u);
    assert.match(prompt, /<issue>\nWhen DEBUG is True[^\n]*help\.\n<\/issue>/u, "the statement is delimited and trimmed, never reflowed");
    assert.ok(prompt.trimEnd().endsWith("reading its diff."), "the deliverable, then the working-tree check, close the prompt");
    // plurnk-bench#44 — two confabulated completions shipped no patch; the prompt asks for the check.
    assert.match(prompt, /Before concluding, confirm that the working tree carries your change/u);
    // Neither addition the official prompt declines to make: no brevity ask, no test warning.
    assert.ok(!/smallest|minimal|brief|concise/iu.test(prompt), "no brevity ask — scope is not size");
    // The eval script resets test files before applying the test patch, so tampering is already
    // inert: naming it would only make it salient.
    assert.ok(!/test/iu.test(prompt.split("</issue>")[1] ?? ""), "the instruction does not mention tests");
    // The failure this exists to prevent: a diagnosis is not a patch.
    assert.match(prompt, /an explanation of the fix is not a\nfix/u);
    // It must not coach the op language — plurnk.md owns that, and coaching would not be the
    // harness under test any more.
    for (const op of ["EDIT", "FIND", "READ", "SEND", "NOTE", "backtick"]) {
        assert.ok(!prompt.includes(op), `the task prompt must not teach ${op}`);
    }
});

test("[§swebench-profiles] the study's turn cap is the bound, not our wall clock", () => {
    const argv = candidateArgv("/r", 14400, "task", 100);
    assert.equal(argv[argv.indexOf("--max-turns") + 1], "100", "HarnessTax capped each attempt at 100 model turns");
    // The wall clock is a runaway guard: it must sit far above any plausible 100-turn rollout, or
    // a slow route records a timeout where the study would have recorded a turn count.
    assert.equal(argv[argv.indexOf("--timeout") + 1], "14400");
});
