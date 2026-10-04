import assert from "node:assert/strict";
import test from "node:test";
import { corpusIds, donePairs, planTrials } from "./plan.ts";

test("[§swebench-profiles] a launch runs the corpus in order, drops --skip ids and what its halt policy let run on, and --limit bounds this launch", () => {
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
