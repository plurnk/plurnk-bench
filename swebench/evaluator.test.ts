import { test } from "node:test";
import assert from "node:assert/strict";
import {
    aggregateReportPath,
    instanceReportPath,
    predictionsJsonl,
    rewardFromInstanceReport,
    type SweInstanceReport,
} from "./evaluator.ts";
import { joinRecord, type PlurnkDoc } from "../src/ingest.ts";

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

test("[§swebench-evaluator] a resolved instance is reward 1 with f2p/p2p counts and a full partial", () => {
    assert.deepEqual(rewardFromInstanceReport(RESOLVED), {
        reward: 1,
        partial: 1,
        f2p_total: 1,
        f2p_passed: 1,
        p2p_total: 2,
        p2p_passed: 2,
    });
});

test("[§swebench-evaluator] a non-resolved instance is reward 0 and never invents a pass", () => {
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

test("[§swebench-evaluator] absence and infrastructure failure are the same honest null, never 0", () => {
    assert.equal(rewardFromInstanceReport(null), null);
    assert.equal(rewardFromInstanceReport(undefined), null);
    assert.equal(rewardFromInstanceReport({ ...RESOLVED, infra_failure: true }), null);
});

test("[§swebench-evaluator] a patch that failed to apply is recorded, not silently graded", () => {
    const reward = rewardFromInstanceReport({ ...RESOLVED, resolved: false, patch_successfully_applied: false });
    assert.equal(reward?.reward, 0);
    assert.equal(reward?.apply_failed, 1);
});

test("[§swebench-evaluator] the oracle join flows through the shared core to a BenchRecord verdict", () => {
    const doc: PlurnkDoc = {
        schemaVersion: 6,
        finalStatus: 200,
        workspace: { id: 1, name: "bench" },
        workerId: 7,
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

test("[§swebench-evaluator] report paths follow the harness's own layout", () => {
    assert.equal(aggregateReportPath("/r", "run1", "gold"), "/r/gold.run1.json");
    assert.equal(
        instanceReportPath("/r", "run1", "gold", "mwaskom__seaborn-3010"),
        "/r/logs/run_evaluation/run1/gold/mwaskom__seaborn-3010/report.json",
    );
});

test("[§swebench-evaluator] predictions serialize one JSON object per line", () => {
    assert.equal(
        predictionsJsonl([{ instance_id: "i", model_name_or_path: "gold", model_patch: "diff" }]),
        '{"instance_id":"i","model_name_or_path":"gold","model_patch":"diff"}\n',
    );
    assert.equal(predictionsJsonl([]), "");
});
