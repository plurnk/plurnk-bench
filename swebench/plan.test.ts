import assert from "node:assert/strict";
import test from "node:test";
import { corpusIds, passedPairs, planTrials } from "./plan.ts";

test("[§swebench-profiles] a launch runs the corpus in order, drops --skip ids and recorded clean passes, and --limit bounds this launch", () => {
    const ids = corpusIds({ dataset: "SWE-bench/SWE-bench_Lite", ids: ["a", "b", "c", "d"] });
    assert.deepEqual(ids, ["a", "b", "c", "d"]);
    const passed = passedPairs([
        "a\t1\t0\t/t/a\t/p/a\tpass",
        "b\t1\t1\t\t\tharness: rc=1, no trial directory",
        "c\t1\t0\t/t/c\t/p/c\tfail: reward 0",
    ].join("\n") + "\n");
    assert.deepEqual([...passed], ["a\t1"], "only a clean pass is done; a halted trial runs again unless its id is skipped");
    assert.deepEqual(planTrials({ ids, attempts: 1, limit: 0, only: [], skip: ["c"], passed }), [{ id: "b", attempt: 1 }, { id: "d", attempt: 1 }]);
    assert.deepEqual(
        planTrials({ ids, attempts: 2, limit: 0, only: ["a", "b"], skip: [], passed }),
        [{ id: "b", attempt: 1 }, { id: "a", attempt: 2 }, { id: "b", attempt: 2 }],
        "attempts are attempt-major, as the study's three rollouts per task",
    );
    assert.deepEqual(planTrials({ ids, attempts: 1, limit: 1, only: [], skip: [], passed: new Set() }), [{ id: "a", attempt: 1 }], "--limit 1 is the pilot");
    assert.deepEqual(planTrials({ ids, attempts: 1, limit: 0, only: [], skip: ["c", "b"], passed }), [{ id: "d", attempt: 1 }], "an accepted failure is a skip on every later launch");
    assert.throws(() => corpusIds({ dataset: "x" }), /corpus carries no ids/);
});
