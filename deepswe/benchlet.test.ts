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
    digestSummary,
    gradeObservations,
    parseGoTestEvents,
    requiemIsComplete,
    runToFiles,
} from "./benchlet.ts";

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
        workers: [{ id: 4, name: "model-1" }],
        loops: [{
            id: 2,
            worker_id: 4,
            sequence: 1,
            status: 500,
            terminal_message: "invalid emission",
            terminated_by: null,
            result: {
                status: 500,
                problem: {
                    type: "https://problems.plurnk.dev/engine/generation/invalid-emission-exhausted",
                    status: 500,
                },
            },
        }],
        turns: [],
        turn_attempts: [],
        log_entries: [],
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
    }]);
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
        assert.equal(basename(allocateRun(root, "grok")), "run2-deepswe-abs-grok");
        assert.equal(basename(allocateRun(root, "grok")), "run3-deepswe-abs-grok");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("[§benchlet-failure] benchlet requires both requiem artifacts and a successful requiem process", () => {
    assert.equal(requiemIsComplete(0, true, true), true);
    assert.equal(requiemIsComplete(1, true, true), false);
    assert.equal(requiemIsComplete(0, true, false), false);
    assert.equal(requiemIsComplete(0, false, true), false);
});
