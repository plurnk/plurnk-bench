import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import {
    allocateRun,
    candidateTimeoutMs,
    candidatePolicyPath,
    candidatePolicySnapshotPath,
    digestSummary,
    gradeObservations,
    manifestPathForTask,
    parseGoTestEvents,
    parseTaskVerifierArtifacts,
    requiemIsComplete,
    requiemModelAlias,
    runToFiles,
} from "./benchlet.ts";

test("[§benchlet-evidence] benchlet resolves and snapshots the service candidate personality", () => {
    assert.equal(
        candidatePolicyPath("/source/plurnk-service"),
        "/source/plurnk-service/plurnk-meta/PLURNK_PERSONALITY.md",
    );
    assert.equal(
        candidatePolicySnapshotPath("/artifacts/run46"),
        "/artifacts/run46/candidate-policy.md",
    );
});

test("[§benchlet-oracle] benchlet parses exact go test events and keeps failure output", () => {
    const events = [
        JSON.stringify({ Action: "run", Package: "example.test/pkg", Test: "TestOne" }),
        JSON.stringify({ Action: "output", Package: "example.test/pkg", Test: "TestOne", Output: "failure detail\n" }),
        JSON.stringify({ Action: "fail", Package: "example.test/pkg", Test: "TestOne" }),
        JSON.stringify({ Action: "pass", Package: "example.test/pkg", Test: "TestTwo" }),
    ].join("\n");

    const parsed = parseGoTestEvents(events);

    assert.deepEqual(parsed.get("example.test/pkg.TestOne"), {
        status: "failed",
        output: "failure detail",
    });
    assert.deepEqual(parsed.get("example.test/pkg.TestTwo"), {
        status: "passed",
        output: "",
    });
});

test("[§benchlet-oracle] benchlet rejects malformed go test JSON instead of silently losing evidence", () => {
    assert.throws(
        () => parseGoTestEvents('{"Action":"pass"}\nnot-json'),
        /go test -json emitted malformed JSON on line 2/,
    );
});

test("[§benchlet-oracle] benchlet preserves a test interrupted before its terminal event", () => {
    const events = [
        JSON.stringify({ Action: "run", Package: "example.test/pkg", Test: "TestInterrupted" }),
        JSON.stringify({
            Action: "output",
            Package: "example.test/pkg",
            Test: "TestInterrupted",
            Output: "=== RUN   TestInterrupted\n",
        }),
        JSON.stringify({ Action: "output", Package: "example.test/pkg", Output: "FAIL\texample.test/pkg\n" }),
        JSON.stringify({ Action: "fail", Package: "example.test/pkg" }),
    ].join("\n");

    const parsed = parseGoTestEvents(events);

    assert.deepEqual(parsed.get("example.test/pkg.TestInterrupted"), {
        status: "failed",
        output: [
            "=== RUN   TestInterrupted",
            "go test ended after starting this test without emitting a terminal event",
        ].join("\n"),
    });
});

test("[§benchlet-oracle] benchlet grading distinguishes absent evidence from a pass", () => {
    const result = gradeObservations({
        base_commit: "base",
        p2p_node_ids: ["example.test/pkg.TestBase"],
        f2p_node_ids: ["example.test/pkg.TestFeature"],
    }, new Map([
        ["example.test/pkg.TestBase", { status: "passed", output: "" }],
    ]));

    assert.equal(result.reward, 0);
    assert.equal(result.p2pPassed, 1);
    assert.equal(result.f2pPassed, 0);
    assert.equal(result.tests[1]?.status, "failed");
    assert.equal(result.tests[1]?.output, "test absent from oracle output");
});

test("[§benchlet-oracle] benchlet grading rejects an unapplied patch without running tests", () => {
    const result = gradeObservations({
        base_commit: "base",
        p2p_node_ids: ["example.test/pkg.TestBase"],
        f2p_node_ids: ["example.test/pkg.TestFeature"],
    }, new Map([
        ["example.test/pkg.TestBase", { status: "passed", output: "" }],
        ["example.test/pkg.TestFeature", { status: "passed", output: "" }],
    ]), true);

    assert.equal(result.applyFailed, true);
    assert.equal(result.reward, 0);
    assert.equal(result.partial, 0);
    assert.ok(result.tests.every((entry) => entry.output === "submission patch did not apply"));
});

test("[§benchlet-evidence] benchlet summary preserves the terminal loop Problem", () => {
    const summary = digestSummary({
        workspaces: [{
            accounting: {
                requests: [],
                usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    inputTokenDetails: {
                        noCacheTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                    },
                    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
                },
                costUsd: "0",
            },
        }],
        workers: [{ id: 4, name: "model-1" }],
        loops: [{
            id: 2,
            worker_id: 4,
            sequence: 1,
            status: 500,
            terminated_by: null,
            result: {
                status: 500,
                content: "invalid emission",
                problem: {
                    type: "https://problems.plurnk.dev/engine/generation/invalid-emission-exhausted",
                    status: 500,
                },
            },
        }, {
            id: 3,
            worker_id: 4,
            sequence: 2,
            status: 102,
            terminated_by: null,
            result: null,
        }],
        turns: [],
        turn_attempts: [],
        provider_requests: [],
        log_entries: [{
            id: 1,
            worker_id: 4,
            origin: "model",
            op: null,
            target: null,
            status_rx: 200,
            attrs: {},
            problem: null,
        }, {
            id: 2,
            worker_id: 4,
            origin: "model",
            op: "PLAN",
            target: null,
            status_rx: 200,
            attrs: {},
            problem: null,
        }],
    });

    assert.deepEqual(summary.loopOutcomes, [{
        workerId: 4,
        workerName: "model-1",
        loop: 1,
        status: 500,
        terminalMessage: "invalid emission",
        terminatedBy: null,
        problem: {
            type: "https://problems.plurnk.dev/engine/generation/invalid-emission-exhausted",
            status: 500,
        },
    }, {
        workerId: 4,
        workerName: "model-1",
        loop: 2,
        status: 102,
        terminalMessage: null,
        terminatedBy: null,
        problem: null,
    }]);
    assert.deepEqual(summary.operationCounts, { PLAN: 1 });
});

test("[§benchlet-evidence] benchlet groups terminal stream channels into one causal failure", () => {
    const nonzeroExit = "https://problems.plurnk.dev/executor/subprocess/nonzero-exit";
    const entryNotFound = "https://problems.plurnk.dev/scheme/sh/entry-not-found";
    const summary = digestSummary({
        workspaces: [{
            accounting: {
                requests: [],
                usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                    inputTokenDetails: {
                        noCacheTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                    },
                    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
                },
                costUsd: "0",
            },
        }],
        workers: [{ id: 4, name: "model-1" }],
        loops: [],
        turns: [],
        turn_attempts: [],
        provider_requests: [],
        log_entries: [{
            id: 10,
            worker_id: 4,
            origin: "model",
            op: "EXEC",
            target: null,
            status_rx: 200,
            attrs: { stream: "sh:///1/2/3" },
            problem: null,
        }, {
            id: 11,
            worker_id: 4,
            origin: "plurnk",
            op: "READ",
            target: "sh:///1/2/3#stdout",
            status_rx: 500,
            attrs: { terminal: true },
            problem: {
                type: nonzeroExit,
                title: "Nonzero exit",
                status: 500,
                detail: "'sh' exited with code 2.",
                instance: "log:///1/3/1/READ",
            },
        }, {
            id: 12,
            worker_id: 4,
            origin: "plurnk",
            op: "READ",
            target: "sh:///1/2/3#stderr",
            status_rx: 500,
            attrs: { terminal: true },
            problem: {
                type: nonzeroExit,
                title: "Nonzero exit",
                status: 500,
                detail: "'sh' exited with code 2.",
                instance: "log:///1/3/2/READ",
            },
        }, {
            id: 13,
            worker_id: 4,
            origin: "model",
            op: "EXEC",
            target: "sh:///1/1/9",
            status_rx: 404,
            attrs: { stream: "sh:///1/3/3" },
            problem: {
                type: entryNotFound,
                title: "Entry not found",
                status: 404,
                detail: "No entry exists at sh:///1/1/9.",
                instance: "log:///1/3/3/EXEC",
            },
        }],
    });

    assert.deepEqual(summary.failures, {
        observationRows: 3,
        problemTypes: {
            [nonzeroExit]: 1,
            [entryNotFound]: 1,
        },
        incidents: [{
            kind: "stream",
            workerId: 4,
            address: "sh:///1/2/3",
            operation: "EXEC",
            operationEntryId: 10,
            status: 500,
            problemType: nonzeroExit,
            title: "Nonzero exit",
            detail: "'sh' exited with code 2.",
            observationRows: 2,
            channels: ["stderr", "stdout"],
        }, {
            kind: "operation",
            workerId: 4,
            address: "log:///1/3/3/EXEC",
            operation: "EXEC",
            operationEntryId: 13,
            status: 404,
            problemType: entryNotFound,
            title: "Entry not found",
            detail: "No entry exists at sh:///1/1/9.",
            observationRows: 1,
            channels: [],
        }],
    });
});

test("[§benchlet-evidence] benchlet shell owns the operator environment bootstrap", () => {
    const shell = readFileSync(new URL("./benchlet.sh", import.meta.url), "utf8");

    assert.match(shell, /PLURNK_BENCHLET_SHELL_READY/);
    assert.match(shell, /\.bashrc/);
    assert.match(shell, /exec node --conditions=plurnk-dev/);
});

test("[§benchlet-evidence] benchlet waits until complete stdout and stderr artifacts are durable", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-capture-"));
    try {
        const stdoutPath = resolve(root, "stdout.log");
        const stderrPath = resolve(root, "stderr.log");
        const stdout = "o".repeat(1_000_000);
        const stderr = "e".repeat(1_000_000);
        const result = await runToFiles(process.execPath, [
            "-e",
            'process.stdout.write("o".repeat(1_000_000)); process.stderr.write("e".repeat(1_000_000));',
        ], {
            cwd: root,
            stdoutPath,
            stderrPath,
        });

        assert.equal(result.status, 0);
        assert.equal(result.timedOut, false);
        assert.equal(readFileSync(stdoutPath, "utf8"), stdout);
        assert.equal(readFileSync(stderrPath, "utf8"), stderr);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("[§benchlet-evidence] benchlet marks and terminates a process that exceeds its harness watchdog", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-timeout-"));
    try {
        const result = await runToFiles(process.execPath, [
            "-e",
            "setInterval(() => {}, 1_000);",
        ], {
            cwd: root,
            stdoutPath: resolve(root, "stdout.log"),
            stderrPath: resolve(root, "stderr.log"),
            timeoutMs: 25,
        });

        assert.equal(result.timedOut, true);
        assert.equal(result.signal, "SIGTERM");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("[§benchlet-location] benchlet allocates flat run numbers without reusing a claimed directory", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-numbering-"));
    try {
        mkdirSync(resolve(root, "run1-old"));
        assert.equal(
            basename(allocateRun(root, "happy-dom-abort-pending-body-reads", "glm")),
            "run2-deepswe-happy-dom-abort-pending-body-reads-glm",
        );
        assert.equal(
            basename(allocateRun(root, "happy-dom-abort-pending-body-reads", "glm")),
            "run3-deepswe-happy-dom-abort-pending-body-reads-glm",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("[§benchlet-provenance] benchlet resolves only pinned, path-safe task manifests", () => {
    assert.equal(
        basename(manifestPathForTask("happy-dom-abort-pending-body-reads")),
        "happy-dom-abort-pending-body-reads.json",
    );
    assert.throws(() => manifestPathForTask("../untracked-task"), /invalid benchlet task name/);
});

test("[§benchlet-oracle] benchlet preserves canonical task-verifier evidence", () => {
    const result = parseTaskVerifierArtifacts({
        base_commit: "base",
        p2p_node_ids: ["base behavior"],
        f2p_node_ids: ["new behavior"],
    }, {
        reward: 0,
        p2p_passed: 1,
        p2p_total: 1,
        f2p_passed: 0,
        f2p_total: 1,
        partial: 0.5,
    }, {
        results: {
            tests: [
                { name: "[p2p] base behavior", status: "passed" },
                { name: "[f2p] new behavior", status: "failed", message: "expected AbortError" },
            ],
        },
    });

    assert.equal(result.reward, 0);
    assert.equal(result.partial, 0.5);
    assert.deepEqual(result.tests[1], {
        nodeId: "new behavior",
        bucket: "f2p",
        status: "failed",
        output: "expected AbortError",
    });
});

test("[§benchlet-oracle] benchlet rejects inconsistent task-verifier summaries", () => {
    assert.throws(() => parseTaskVerifierArtifacts({
        base_commit: "base",
        p2p_node_ids: ["base behavior"],
        f2p_node_ids: ["new behavior"],
    }, {
        reward: 1,
        p2p_passed: 1,
        p2p_total: 1,
        f2p_passed: 1,
        f2p_total: 1,
        partial: 1,
    }, {
        results: {
            tests: [
                { name: "[p2p] base behavior", status: "passed" },
                { name: "[f2p] new behavior", status: "failed" },
            ],
        },
    }), /CTRF and reward disagree on f2p passes/);
});

test("[§benchlet-failure] benchlet requires both requiem artifacts and a successful requiem process", () => {
    assert.equal(requiemIsComplete(0, true, true), true);
    assert.equal(requiemIsComplete(1, true, true), false);
    assert.equal(requiemIsComplete(0, true, false), false);
    assert.equal(requiemIsComplete(0, false, true), false);
});

test("[§benchlet-requiem-witness] requiem selection is independent and explicit", () => {
    assert.equal(requiemModelAlias(true, "glm"), "glm");
    assert.equal(requiemModelAlias(false, undefined), null);
    assert.throws(
        () => requiemModelAlias(true, undefined),
        /PLURNK_BENCHLET_REQUIEM_MODEL must name a model alias/,
    );
});
test("[§benchlet-candidate-timeout] -1 disables the candidate timer; positive values add the overhead", () => {
    assert.equal(candidateTimeoutMs(-1, 900), undefined);
    assert.equal(candidateTimeoutMs(5280, 900), 6_180_000);
});
