import test from "node:test";
import assert from "node:assert/strict";
import { candidateArgv, exceptionInfo, extractPlurnkDoc } from "./run.ts";

test("[§swebench] the candidate runs the ordinary client: --json, --auto, the task prompt after --", () => {
    assert.deepEqual(candidateArgv("/runs/run1/repo", 1680, "Fix the missing-data crash"), [
        "scripts/candidate.mjs",
        "--json",
        "--auto",
        "--project-root", "/runs/run1/repo",
        "--timeout", "1680",
        "--", "Fix the missing-data crash",
    ]);
});

test("[§swebench] -1 is the no-limit idiom: no --timeout flag is emitted", () => {
    assert.deepEqual(candidateArgv("/r", -1, "p"), [
        "scripts/candidate.mjs", "--json", "--auto", "--project-root", "/r", "--", "p",
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
