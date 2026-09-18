import test from "node:test";
import assert from "node:assert/strict";
import { candidateArgv, extractPlurnkDoc } from "./run.ts";

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
