import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { aliasConfiguration, allocateRun, captureTree, isTreeManifest, treeInstruction, parseTreeVerifierArtifacts, candidateTimeoutMs, candidateOutcome, producedNoPatch, EMPTY_SHA256, candidatePolicyPath, candidatePolicySnapshotPath, candidateRecapSnapshotPath, digestSummary, baselineInvalidity, EXECUTOR_SHIMS, executorShim, environmentExcludedP2p, gradeObservations, manifestPathForTask, parseGoTestEvents, parseTaskVerifierArtifacts, recordInfrastructureFailure, requiemIsComplete, requiemModelAlias, runToFiles, summarizeFailures, withoutExcluded } from "./benchlet.ts";

// ─── benchlet.test.ts ───
{
test("{§benchlet-diagnostic} benchlet resolves and snapshots the service candidate policy", () => {
    assert.equal(
        candidatePolicyPath("/source/plurnk-service"),
        "/source/plurnk-service/plurnk-meta/POLICY.md",
    );
    assert.equal(
        candidatePolicySnapshotPath("/artifacts/run46"),
        "/artifacts/run46/candidate-policy.md",
    );
    assert.equal(
        candidateRecapSnapshotPath("/artifacts/run46"),
        "/artifacts/run46/candidate-recap.md",
        "a per-run recap is snapshotted beside the policy",
    );
});

test("{§benchlet-diagnostic} benchlet parses exact go test events and keeps failure output", () => {
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

test("{§benchlet-diagnostic} benchlet rejects malformed go test JSON instead of silently losing evidence", () => {
    assert.throws(
        () => parseGoTestEvents('{"Action":"pass"}\nnot-json'),
        /go test -json emitted malformed JSON on line 2/,
    );
});

test("{§benchlet-diagnostic} benchlet preserves a test interrupted before its terminal event", () => {
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

test("{§benchlet-diagnostic} an executor shim carries its container, repository, user, image home, and host PATH as literals and forwards only from inside the repository", () => {
    assert.ok(["sh", "node", "python3", "npm", "cargo", "go"].every((name) => EXECUTOR_SHIMS.includes(name)));
    const shim = executorShim("python3", { container: "c0ffee", repository: "/runs/run7/repo", user: "1000:1000", home: "/root", realPath: "/usr/bin:/bin" });
    assert.equal(shim, [
        "#!/bin/sh",
        "# {§benchlet-diagnostic} — inside the candidate repository the command runs in the task container",
        "# at the same path; anywhere else it runs on the host.",
        'case "${PWD}/" in',
        "    '/runs/run7/repo/'*) exec docker exec -i -u '1000:1000' -w \"${PWD}\" -e HOME='/root' 'c0ffee' python3 \"$@\" ;;",
        "esac",
        "PATH='/usr/bin:/bin' exec python3 \"$@\"",
        "",
    ].join("\n"));
});

test("{§benchlet-diagnostic} a pass-to-pass test failing on the pristine baseline leaves this run's graded set with evidence", () => {
    const config = {
        base_commit: "base",
        p2p_node_ids: ["pkg.Stable", "pkg.LoginTiming", "pkg.AlsoStable"],
        f2p_node_ids: ["pkg.Feature"],
    };
    const baseline = gradeObservations(config, new Map([
        ["pkg.Stable", { status: "passed", output: "" }],
        ["pkg.LoginTiming", { status: "failed", output: "Expected: 401\nReceived: 425" }],
        ["pkg.AlsoStable", { status: "passed", output: "" }],
        ["pkg.Feature", { status: "failed", output: "not yet" }],
    ]));
    assert.equal(baselineInvalidity(baseline), null, "one timing-flaky p2p test is an exclusion, not a broken task");
    const excluded = environmentExcludedP2p(baseline);
    assert.deepEqual(excluded.map(({ nodeId, output }) => [nodeId, output]), [["pkg.LoginTiming", "Expected: 401\nReceived: 425"]]);
    const runConfig = withoutExcluded(config, excluded);
    assert.deepEqual(runConfig.p2p_node_ids, ["pkg.Stable", "pkg.AlsoStable"]);
    assert.deepEqual(runConfig.f2p_node_ids, ["pkg.Feature"], "fail-to-pass ids are never excused");
    assert.deepEqual(config.p2p_node_ids, ["pkg.Stable", "pkg.LoginTiming", "pkg.AlsoStable"], "the pinned config is untouched");
    const graded = gradeObservations(runConfig, new Map([
        ["pkg.Stable", { status: "passed", output: "" }],
        ["pkg.AlsoStable", { status: "passed", output: "" }],
        ["pkg.Feature", { status: "passed", output: "" }],
    ]));
    assert.equal(graded.reward, 1, "the candidate is graded on what can discriminate here");
    assert.equal(graded.p2pTotal, 2);
});

test("{§benchlet-diagnostic} a passing fail-to-pass test or a tenth of p2p failing at baseline is still a broken environment", () => {
    const config = {
        base_commit: "base",
        p2p_node_ids: Array.from({ length: 20 }, (_, index) => `pkg.P${index}`),
        f2p_node_ids: ["pkg.Feature"],
    };
    const observe = (failingP2p: number, featurePasses: boolean) => gradeObservations(config, new Map([
        ...config.p2p_node_ids.map((nodeId, index): [string, { status: "passed" | "failed"; output: string }] =>
            [nodeId, { status: index < failingP2p ? "failed" : "passed", output: "" }]),
        ["pkg.Feature", { status: featurePasses ? "passed" : "failed", output: "" }],
    ]));
    assert.equal(baselineInvalidity(observe(2, false)), null, "two of twenty is within a tenth");
    assert.match(baselineInvalidity(observe(3, false)) ?? "", /more than a tenth fail before any model runs/u);
    assert.match(baselineInvalidity(observe(0, true)) ?? "", /f2p 1\/1/u);
});

test("{§benchlet-diagnostic} benchlet grading distinguishes absent evidence from a pass", () => {
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

test("{§benchlet-diagnostic} benchlet grading rejects an unapplied patch without running tests", () => {
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

test("{§benchlet-diagnostic} benchlet summary preserves the terminal loop Problem", () => {
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
        sessions: [{ id: 4, name: "model-1" }],
        loops: [{
            id: 2,
            session_id: 4,
            sequence: 1,
            status: 500,
            terminated_by: null,
            result: {
                status: 500,
                content: "invalid emission",
                problem: {
                    type: "https://problems.plurnk.xyz/engine/generation/invalid-emission-exhausted",
                    status: 500,
                },
            },
        }, {
            id: 3,
            session_id: 4,
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
            session_id: 4,
            origin: "model",
            op: null,
            target: null,
            status_rx: 200,
            attrs: {},
            problem: null,
        }, {
            id: 2,
            session_id: 4,
            origin: "model",
            op: "PLAN",
            target: null,
            status_rx: 200,
            attrs: {},
            problem: null,
        }],
    });

    assert.deepEqual(summary.loopOutcomes, [{
        sessionId: 4,
        sessionName: "model-1",
        loop: 1,
        status: 500,
        terminalMessage: "invalid emission",
        terminatedBy: null,
        problem: {
            type: "https://problems.plurnk.xyz/engine/generation/invalid-emission-exhausted",
            status: 500,
        },
    }, {
        sessionId: 4,
        sessionName: "model-1",
        loop: 2,
        status: 102,
        terminalMessage: null,
        terminatedBy: null,
        problem: null,
    }]);
    assert.deepEqual(summary.operationCounts, { PLAN: 1 });
});

test("{§benchlet-diagnostic} benchlet groups terminal stream channels into one causal failure", () => {
    const nonzeroExit = "https://problems.plurnk.xyz/executor/subprocess/nonzero-exit";
    const entryNotFound = "https://problems.plurnk.xyz/scheme/sh/entry-not-found";
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
        sessions: [{ id: 4, name: "model-1" }],
        loops: [],
        turns: [],
        turn_attempts: [],
        provider_requests: [],
        log_entries: [{
            id: 10,
            session_id: 4,
            origin: "model",
            op: "sh",
            target: null,
            status_rx: 200,
            attrs: { stream: "sh:///1/2/3" },
            problem: null,
        }, {
            id: 11,
            session_id: 4,
            origin: "_plurnk",
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
            session_id: 4,
            origin: "_plurnk",
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
            session_id: 4,
            origin: "model",
            op: "sh",
            target: "sh:///1/1/9",
            status_rx: 404,
            attrs: { stream: "sh:///1/3/3" },
            problem: {
                type: entryNotFound,
                title: "Entry not found",
                status: 404,
                detail: "No entry exists at sh:///1/1/9.",
                instance: "log:///1/3/3/sh",
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
            sessionId: 4,
            address: "sh:///1/2/3",
            operation: "sh",
            operationEntryId: 10,
            status: 500,
            problemType: nonzeroExit,
            title: "Nonzero exit",
            detail: "'sh' exited with code 2.",
            observationRows: 2,
            channels: ["stderr", "stdout"],
        }, {
            kind: "operation",
            sessionId: 4,
            address: "log:///1/3/3/sh",
            operation: "sh",
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

test("{§benchlet-diagnostic} benchlet shell owns the operator environment bootstrap", () => {
    const shell = readFileSync(new URL("./benchlet.sh", import.meta.url), "utf8");

    assert.match(shell, /PLURNK_BENCHLET_SHELL_READY/);
    assert.match(shell, /\.bashrc/);
    assert.match(shell, /exec node --conditions=plurnk-dev/);
});

test("{§benchlet-diagnostic} benchlet waits until complete stdout and stderr artifacts are durable", async () => {
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

test("{§benchlet-diagnostic} benchlet marks and terminates a process that exceeds its harness watchdog", async () => {
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

test("{§benchlet-diagnostic} benchlet interruption terminates its child after durable output", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-interruption-"));
    try {
        const stdoutPath = resolve(root, "stdout.log");
        const stderrPath = resolve(root, "stderr.log");
        const controller = new AbortController();
        const running = runToFiles(process.execPath, [
            "-e",
            'process.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
        ], {
            cwd: root,
            stdoutPath,
            stderrPath,
            signal: controller.signal,
            timeoutMs: 1_000,
        });
        const outputIsReady = (): boolean => existsSync(stdoutPath)
            && readFileSync(stdoutPath, "utf8").includes("ready");
        for (let attempt = 0; attempt < 100 && !outputIsReady(); attempt += 1) {
            await delay(5);
        }
        assert.equal(readFileSync(stdoutPath, "utf8"), "ready\n");

        controller.abort(new Error("benchlet interrupted by SIGTERM"));

        await assert.rejects(running, /benchlet interrupted by SIGTERM/);
        assert.equal(readFileSync(stdoutPath, "utf8"), "ready\n");
        assert.equal(readFileSync(stderrPath, "utf8"), "");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("{§benchlet-diagnostic} benchlet interruption closes its provenance and records the failed stage", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-interruption-record-"));
    try {
        const startedAt = new Date("2026-09-03T12:00:00.000Z");
        const completedAt = new Date("2026-09-03T12:00:09.000Z");
        writeFileSync(resolve(root, "provenance.json"), `${JSON.stringify({
            schemaVersion: 1,
            state: "running",
            identity: "preserved",
        })}\n`);

        recordInfrastructureFailure(
            root,
            "candidate",
            startedAt,
            new Error("benchlet interrupted by SIGTERM"),
            completedAt,
        );

        const result = JSON.parse(readFileSync(resolve(root, "result.json"), "utf8")) as Record<string, unknown>;
        assert.deepEqual(result, {
            schemaVersion: 2,
            harnessStatus: "infrastructure_error",
            infrastructure: {
                stage: "candidate",
                message: "benchlet interrupted by SIGTERM",
            },
            startedAt: startedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: 9_000,
        });
        const provenance = JSON.parse(readFileSync(resolve(root, "provenance.json"), "utf8")) as Record<string, unknown>;
        assert.deepEqual(provenance, {
            schemaVersion: 1,
            state: "infrastructure_error",
            identity: "preserved",
            failedStage: "candidate",
            completedAt: completedAt.toISOString(),
        });
        assert.match(readFileSync(resolve(root, "infrastructure-error.log"), "utf8"), /benchlet interrupted by SIGTERM/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("{§benchlet-diagnostic} benchlet allocates flat run numbers without reusing a claimed directory", () => {
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

test("{§benchlet-diagnostic} benchlet resolves only pinned, path-safe task manifests", () => {
    assert.equal(
        basename(manifestPathForTask("happy-dom-abort-pending-body-reads")),
        "happy-dom-abort-pending-body-reads.json",
    );
    assert.throws(() => manifestPathForTask("../untracked-task"), /invalid benchlet task name/);
});

test("{§benchlet-diagnostic} benchlet preserves canonical task-verifier evidence", () => {
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

test("{§benchlet-diagnostic} benchlet rejects inconsistent task-verifier summaries", () => {
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

test("{§benchlet-diagnostic} benchlet requires both requiem artifacts and a successful requiem process", () => {
    assert.equal(requiemIsComplete(0, true, true), true);
    assert.equal(requiemIsComplete(1, true, true), false);
    assert.equal(requiemIsComplete(0, true, false), false);
    assert.equal(requiemIsComplete(0, false, true), false);
});

test("{§benchlet-diagnostic} requiem selection is independent and explicit", () => {
    assert.equal(requiemModelAlias(true, "glm", "deepdumb"), "glm");
    assert.equal(requiemModelAlias(false, undefined, "deepdumb"), null);
    assert.equal(requiemModelAlias(true, undefined, "deepdumb"), "deepdumb");
});
test("{§benchlet-diagnostic} -1 disables the candidate timer; positive values add the overhead", () => {
    assert.equal(candidateTimeoutMs(-1, 900), undefined);
    assert.equal(candidateTimeoutMs(5280, 900), 6_180_000);
});

test("{§benchlet-diagnostic} summarizeFailures: a child's reconciled execution does not collide with the parent's own stream at the same session-relative coordinate (#464)", () => {
    const exec = (id: number, source: string | null, origin: string) => ({
        id, session_id: 3, op: "sh", origin, state: "resolved", outcome: null,
        target: null, source, status_rx: 200, problem: null,
        attrs: { stream: "sh:///1/2/3", runtime: "sh" },
    });
    // run206's true shape: the parent's own execution plus the child's execution reconciled in with its
    // child-relative coordinate intact.
    assert.doesNotThrow(() => summarizeFailures([
        exec(41, null, "model"),
        exec(187, "session://cli-investigation", "_plurnk"),
    ] as never));
    // The fail-hard survives for true same-namespace duplicates.
    assert.throws(() => summarizeFailures([
        exec(1, null, "model"),
        exec(2, null, "model"),
    ] as never), /assigns stream/);
});

test("{§benchlet-diagnostic} a tree manifest is recognised by its verifier alone", () => {
    const tree = { schemaVersion: 1, task: "t", kind: "terminal-bench", taskCache: ".cache/x", repositoryUrl: null, baseCommit: null, budgetSeconds: 900, environment: { kind: "docker", image: "i", network: "bridge", cpus: 1, memoryMb: 2048 }, verifier: { kind: "tree", timeoutSeconds: 900 }, files: {} } as never;
    const docker = { ...(tree as object), verifier: { kind: "task", timeoutSeconds: 900 } } as never;
    assert.equal(isTreeManifest(tree), true);
    assert.equal(isTreeManifest(docker), false);
    assert.match(allocateRun(mkdtempSync(resolve(tmpdir(), "benchlet-family-")), "sqlite-db-truncate", "kimi", "terminal-bench"), /run1-terminal-bench-sqlite-db-truncate-kimi$/);
});

test("{§benchlet-diagnostic} the tree verifier's reward and CTRF must agree; every test is fail-to-pass", () => {
    const passing = parseTreeVerifierArtifacts("1\n", { results: { tests: [{ name: "test_json_data", status: "passed" }, { name: "test_shape", status: "passed" }] } });
    assert.equal(passing.reward, 1);
    assert.deepEqual([passing.f2pPassed, passing.f2pTotal, passing.p2pTotal], [2, 2, 0]);
    const failing = parseTreeVerifierArtifacts("0\n", { results: { tests: [{ name: "test_json_data", status: "failed", message: "no recover.json" }] } });
    assert.equal(failing.reward, 0);
    assert.equal(failing.tests[0]?.output, "no recover.json");
    assert.throws(() => parseTreeVerifierArtifacts("1\n", { results: { tests: [{ name: "t", status: "failed" }] } }), /disagrees with its CTRF evidence/);
    assert.throws(() => parseTreeVerifierArtifacts("maybe\n"), /unreadable reward/);
    assert.equal(parseTreeVerifierArtifacts("0\n").f2pTotal, 0, "no CTRF is no evidence, never a pass");
});

test("{§benchlet-diagnostic} a task tree's state is its sorted file listing; content changes move the hash", () => {
    const root = mkdtempSync(resolve(tmpdir(), "benchlet-tree-"));
    try {
        const tree = resolve(root, "repo");
        mkdirSync(resolve(tree, "sub"), { recursive: true });
        writeFileSync(resolve(tree, "trunc.db"), "binary bytes");
        writeFileSync(resolve(tree, "sub", "note.txt"), "one");
        const first = captureTree(tree, root);
        assert.equal(first.submissionSha256, first.workingSha256, "a tree has one state, not two patches");
        assert.equal(first.committed, false);
        const listing = JSON.parse(readFileSync(resolve(root, "working-tree.json"), "utf8")) as { files: Array<{ path: string }> };
        assert.deepEqual(listing.files.map(({ path }) => path), ["sub/note.txt", "trunc.db"]);
        assert.equal(captureTree(tree, root).workingSha256, first.workingSha256, "the listing hash is deterministic");
        writeFileSync(resolve(tree, "recover.json"), "[]");
        assert.notEqual(captureTree(tree, root, "deadline-").workingSha256, first.workingSha256);
        assert.ok(existsSync(resolve(root, "deadline-working-tree.json")));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("{§benchlet-diagnostic} the instruction's /app becomes the host tree; unrelated words survive", () => {
    assert.equal(
        treeInstruction("Write to /app/recover.json; the db is /app/trunc.db (in /app).", "/tmp/run/repo"),
        "Write to /tmp/run/repo/recover.json; the db is /tmp/run/repo/trunc.db (in /tmp/run/repo).",
    );
    assert.equal(treeInstruction("the /application folder and /apps", "/x"), "the /application folder and /apps");
});

test("{§bench-relock} provenance records the alias's route knobs by name, never a credential", () => {
    const env = {
        PLURNK_MODEL_dumbox: "fireworks-ai/accounts/fireworks/models/glm-5p3-flash",
        PLURNK_PROVIDERS_EFFORT_dumbox: "medium",
        PLURNK_PROVIDERS_SERVICE_TIER_dumbox: "priority",
        PLURNK_PROVIDERS_API_KEY_dumbox: "never",
        PLURNK_MODEL_other: "elsewhere",
    };
    assert.deepEqual(aliasConfiguration("dumbox", env), {
        PLURNK_MODEL_dumbox: "fireworks-ai/accounts/fireworks/models/glm-5p3-flash",
        PLURNK_PROVIDERS_EFFORT_dumbox: "medium",
        PLURNK_PROVIDERS_SERVICE_TIER_dumbox: "priority",
    });
    assert.deepEqual(aliasConfiguration("unset", env), {});
});

// {§benchlet-diagnostic} (#41) — the DeepSWE half of the two holes closed for SWE-bench in #40.
test("{§benchlet-diagnostic} only a candidate that exited cleanly finished; a kill is named", () => {
    const clean = { status: 0, signal: null, timedOut: false };
    assert.equal(candidateOutcome(clean), "finished");
    assert.equal(candidateOutcome({ ...clean, timedOut: true }), "timeout");
    assert.equal(candidateOutcome({ status: null, signal: null, timedOut: false, error: new Error("spawn ENOENT") }), "spawn_failed");
    assert.equal(candidateOutcome({ status: 1, signal: null, timedOut: false }), "exited");
    assert.equal(candidateOutcome({ status: null, signal: "SIGKILL", timedOut: false }), "exited");
    // The three dumbox-20260918 runs the provider cut at 600 s reported `exception_info: null`
    // and a complete harness status. A timeout is no longer indistinguishable from a clean finish.
    assert.notEqual(candidateOutcome({ ...clean, timedOut: true }), candidateOutcome(clean));
});

test("{§benchlet-diagnostic} a repository that never changed is recorded as producing no patch", () => {
    // git wrote a diff and the diff was zero bytes — the model changed nothing.
    assert.equal(EMPTY_SHA256, createHash("sha256").update("").digest("hex"));
    assert.equal(producedNoPatch(EMPTY_SHA256), true);
    assert.equal(producedNoPatch(createHash("sha256").update("diff --git a/x b/x\n").digest("hex")), false);
});
}

// ─── smoke.test.ts ───
{
const smoke = readFileSync(new URL("./smoke.sh", import.meta.url), "utf8");

test("{§config-carry} the official minimal manifest retains the executor switch", () => {
    const official = smoke.split('if [ "$TASK" = all ]; then')[2]!.split("\nelse\n")[0]!;
    assert.match(official, /--agent-env "PLURNK_EXECS_PLURNK_QUESTION=\$PLURNK_EXECS_PLURNK_QUESTION"/);
    // Server approval covers the whole benchmark session tree.
    assert.match(official, /--agent-env "PLURNK_SERVICE_PROPOSALS=\$PLURNK_SERVICE_PROPOSALS"/);
});

test("{§config-carry} smoke pins resolved service and client publications", () => {
    assert.match(smoke, /npm view @plurnk\/plurnk-service version/);
    assert.match(smoke, /npm view @plurnk\/plurnk version/);
    assert.match(smoke, /--agent-kwarg "service_version=\$SERVICE_VERSION"/);
    assert.match(smoke, /--agent-kwarg "client_version=\$CLIENT_VERSION"/);
    assert.doesNotMatch(smoke, /after a @plurnk version bump/);
});

test("{§config-carry} smoke carries configured Tavily like other optional web providers and records the route", () => {
    assert.doesNotMatch(smoke, /PLAYWRIGHT/);
    assert.match(smoke, /_BASE_URL\$\|_API_KEY\$/);
    assert.doesNotMatch(smoke, /TAVILY_API_KEY\|PLURNK_SCHEMES_HTTP_TAVILY_DEPTH\) continue/);
    assert.match(smoke, /TAVILY_CONFIGURED/);
    assert.match(smoke, /--agent-kwarg "tavily_configured=\$TAVILY_CONFIGURED"/);
    assert.match(smoke, /--agent-kwarg "tavily_depth=\$TAVILY_DEPTH"/);
});

test("{§config-carry} smoke derives the allowlist from the run's aliases and forwards it to the driver", () => {
    assert.match(smoke, /providers\.json/);
    assert.match(smoke, /--agent-kwarg "egress_domains=\$EGRESS_DOMAINS"/);
    assert.match(smoke, /api\.tavily\.com/);
});

test("{§config-carry} the per-run recap rides into the container as a file, never as a tracked edit", () => {
    assert.match(smoke, /PLURNK_BENCH_RECAP is not a readable file/);
    assert.match(smoke, /--agent-kwarg "recap_path=\$\(readlink -f "\$PLURNK_BENCH_RECAP"\)"/);
    assert.match(smoke, /"\$\{recap_flags\[@\]\}"/);
});

test("{§config-carry} the MCP fleet never rides into the container", () => {
    assert.match(smoke, /PLURNK_MCP_\*\) continue;;/);
});

test("{§config-carry} `all` mode runs the corpus web-free on the minimal manifest", () => {
    assert.match(smoke, /\[ "\$TASK" = all \] && TAVILY_API_KEY=""/);
    assert.match(smoke, /select_flags=\(-i "\$PLURNK_BENCH_PREFLIGHT" --n-tasks 1\)/);
    assert.match(smoke, /select_flags=\(--n-concurrent "\$\{PLURNK_BENCH_JOBS:-4\}"\)/);
    assert.doesNotMatch(smoke, /\[ "\$TASK" = all \] && exit 0/);
});

test("{§config-carry} every run samples docker stats once a minute into the job directory until pier exits", () => {
    assert.match(smoke, /while kill -0 "\$PIER_PID" 2>\/dev\/null; do/);
    assert.match(smoke, /docker stats --no-stream --format '\{\{json \.\}\}'/);
    assert.match(smoke, /"\$JOB\/docker-stats\.jsonl"/);
    assert.match(smoke, /sleep 60/);
});

test("{§config-carry} every task image is pulled outside the run, with retries and a disk floor, before any trial starts", () => {
    const prepull = readFileSync(new URL("./prepull.sh", import.meta.url), "utf8");
    assert.match(smoke, /\ndeepswe\/prepull\.sh "\$TASK"\n/);
    assert.ok(smoke.indexOf('deepswe/prepull.sh "$TASK"') < smoke.indexOf("pier run -p"), "images are local before pier starts");
    assert.match(prepull, /docker_image \*= \*"/);
    assert.match(prepull, /xargs -P "\$JOBS"/);
    assert.match(prepull, /for attempt in \$\(seq 1 "\$ATTEMPTS"\)/);
    assert.match(prepull, /FLOOR_GB/);
    assert.match(prepull, /unresolved images — a run must not start trials without them/);
});

test("{§config-carry} the bench's installed service must equal the version the corpus installs", () => {
    assert.match(smoke, /DIGEST_VERSION="\$\(node -e 'console\.log\(require\("@plurnk\/plurnk-service\/package\.json"\)\.version\)'\)"/);
    assert.match(smoke, /\[ "\$DIGEST_VERSION" = "\$SERVICE_VERSION" \] \|\| \{/);
});

test("{§config-carry} the publisher never owns pier's lifetime; a final pass publishes the rest; failed setups are listed", () => {
    assert.match(smoke, /trap 'kill "\$PIER_PID" \$PUB_PID 2>\/dev\/null \|\| true' EXIT INT TERM/);
    assert.match(smoke, /node src\/publish\.ts --watch "\$JOB" --pid "\$PIER_PID" \\\n\s+\|\| echo/);
    assert.match(smoke, /\) &\nPUB_PID=\$!/);
    assert.match(smoke, /wait "\$PIER_PID" \|\| pier_status=\$\?/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=deepswe node src\/publish\.ts "\$JOB"\n/);
    assert.match(smoke, /failed-setup\.txt/);
});

test("{§publish} job scratch lives under the benchmarks home and every trial publishes as it lands", () => {
    assert.match(smoke, /JOBS_ROOT="\$\(node src\/publish\.ts --jobs deepswe\)"/);
    assert.match(smoke, /"\$\{select_flags\[@\]\}" -o "\$JOBS_ROOT" --env docker &/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=deepswe node src\/publish\.ts --watch "\$JOB" --pid "\$PIER_PID"/);
    assert.doesNotMatch(smoke, /ls -dt jobs\//);
});

test("{§config-carry} the runner uses the ordinary PLURNK_MODEL cascade", () => {
    assert.match(smoke, /source_env_file "\$OPERATOR_ENV"\nsource_env_file "\.env\.defaults"/);
    assert.match(smoke, /MODEL="\$PLURNK_MODEL"/);
    assert.doesNotMatch(smoke, /PLURNK_BENCH_MODEL(?!_BASE_URL)|\$\{2:/, "no bench-side model selector; the base-url forward (#12) is not a selection");
});
}
