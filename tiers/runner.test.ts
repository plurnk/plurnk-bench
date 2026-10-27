import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildTierInvocation, publishTierSessions, selectTierSpecimens, tierFiles, tierRunDir } from "./runner.ts";
import { hasAuditOutcome } from "./demo/_audit-oracle.ts";
import { observedScriptExecution, type ScriptReceipt } from "./demo/_script-oracle.ts";
import { latestStableNodeVersion, namesNodeVersion, versionsNamed } from "./demo/_web-oracle.ts";

// ─── runner.test.ts ───
{
test("{§tier-corpus} tierFiles discovers both live and demo specimen suites in sorted order", () => {
    const live = tierFiles("live");
    const demo = tierFiles("demo");
    assert.ok(live.length >= 15, `expected at least 15 live suite files, found ${live.length}`);
    assert.ok(demo.length >= 15, `expected at least 15 demo suite files, found ${demo.length}`);
    assert.deepEqual(live, [...live].toSorted());
    assert.deepEqual(demo, [...demo].toSorted());
});

test("{§tier-corpus} selectTierSpecimens accepts known specimen names and refuses unknown names with the catalog", () => {
    const known = ["live: alpha", "live: beta"];
    assert.deepEqual(selectTierSpecimens(["live: beta"], known, "live"), ["live: beta"]);
    assert.throws(
        () => selectTierSpecimens(["live: gamma"], known, "live"),
        /unknown live specimen: "live: gamma"[\s\S]*live: alpha[\s\S]*live: beta/u,
    );
});

test("{§tier-corpus} buildTierInvocation wires the candidate service lane, client checkout, and exact specimen pattern", () => {
    const runDir = "/tmp/benchmarks/tier-live-20261026T000000Z";
    const invocation = buildTierInvocation({
        tier: "live",
        serviceRoot: "/tmp/lane-a/plurnk-service",
        clientRoot: "/tmp/lane-a/plurnk",
        runDir,
        files: ["/tmp/plurnk-bench/tiers/live/bare.test.ts"],
        names: ["live: a + b (c)"],
    });
    assert.equal(invocation.cwd, "/tmp/lane-a/plurnk-service/plurnk-core");
    assert.equal(invocation.env.PLURNK_TIERS_SERVICE_ROOT, "/tmp/lane-a/plurnk-service/plurnk-core");
    assert.equal(invocation.env.PLURNK_SERVICE_CHECKOUT, "/tmp/lane-a/plurnk-service");
    assert.equal(invocation.env.PLURNK_CLIENT_CHECKOUT, "/tmp/lane-a/plurnk");
    assert.equal(invocation.env.PLURNK_TIER_RUN_DIR, runDir);
    assert.ok(invocation.args.includes("--conditions=plurnk-dev"));
    assert.ok(invocation.args.includes("--test-name-pattern=^(?:live: a \\+ b \\(c\\))$"));
});

test("{§tier-corpus} publishTierSessions writes per-session record.json and a unified tier result.json", () => {
    const root = mkdtempSync(join(tmpdir(), "plurnk-bench-tiers-test-"));
    try {
        const runDir = tierRunDir("live", root, "20261026T120000Z");
        const sessionDir = join(runDir, "live-bare-abc123");
        mkdirSync(join(sessionDir, "digest"), { recursive: true });
        writeFileSync(join(sessionDir, "plurnk.db"), "sqlite-placeholder");
        writeFileSync(
            join(sessionDir, "census.json"),
            JSON.stringify({
                specimen: "live: bare completion",
                label: "live-bare",
                runDir: sessionDir,
                loops: 1,
                turns: 2,
                requests: 1,
            }),
        );
        writeFileSync(
            join(sessionDir, "digest", "digest.json"),
            JSON.stringify({
                workspaces: [
                    {
                        accounting: {
                            requests: [{ model: "xai/grok-4" }],
                            usage: {
                                inputTokens: 120,
                                outputTokens: 30,
                                totalTokens: 150,
                                inputTokenDetails: {
                                    noCacheTokens: 100,
                                    cacheReadTokens: 20,
                                    cacheWriteTokens: 0,
                                },
                                outputTokenDetails: {
                                    reasoningTokens: 10,
                                    textTokens: 20,
                                },
                            },
                            costUsd: "0.0025",
                            knownCostUsd: "0.0025",
                        },
                    },
                ],
                loops: [{ id: 1, status: 200 }],
                turns: [{ id: 1, producer: "_plurnk" }, { id: 2, producer: "model" }],
                provider_requests: [
                    {
                        kind: "emission",
                        accounting: {
                            model: "xai/grok-4",
                            usage: {
                                inputTokens: 120,
                                outputTokens: 30,
                                totalTokens: 150,
                                inputTokenDetails: {
                                    noCacheTokens: 100,
                                    cacheReadTokens: 20,
                                    cacheWriteTokens: 0,
                                },
                                outputTokenDetails: {
                                    reasoningTokens: 10,
                                    textTokens: 20,
                                },
                            },
                            cost: {
                                kind: "charged",
                                amount: { currency: "USD", amount: "0.0025" },
                            },
                        },
                    },
                ],
                log_entries: [],
                turn_attempts: [],
            }),
        );
        writeFileSync(
            join(runDir, "census.json"),
            JSON.stringify({
                verdicts: [
                    {
                        name: "live: bare completion",
                        file: "tiers/live/bare.test.ts",
                        status: "passed",
                        durationMs: 1234.4,
                        reason: null,
                    },
                ],
                sessions: [
                    {
                        specimen: "live: bare completion",
                        label: "live-bare",
                        runDir: sessionDir,
                        loops: 1,
                        turns: 2,
                        requests: 1,
                    },
                ],
            }),
        );

        const { records, summary } = publishTierSessions({
            tier: "live",
            runDir,
            model: "grok",
            env: {},
        });
        assert.equal(records.length, 1);
        assert.equal(records[0]?.harness, "tier-live");
        assert.equal(records[0]?.taskId, "live: bare completion");
        assert.equal(records[0]?.outcome, "pass");
        assert.equal(records[0]?.reward, 1);
        assert.equal(records[0]?.usage?.accounting?.costUsd, "0.0025");

        const writtenRecord = JSON.parse(readFileSync(join(sessionDir, "record.json"), "utf8")) as { outcome: string; reward: number };
        assert.equal(writtenRecord.outcome, "pass");
        assert.equal(writtenRecord.reward, 1);

        assert.equal(summary.passed, 1);
        assert.equal(summary.graded, 1);
        assert.equal(summary.recordedCost.totalUsd, "0.0025");
        const writtenResult = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")) as { passed: number; graded: number };
        assert.equal(writtenResult.passed, 1);
        assert.equal(writtenResult.graded, 1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
}

// ─── oracles.test.ts ───
{
const stream = "sh:///1/2/3/sh";
const execution = (target: string | null, body = ""): ScriptReceipt => ({
    scheme: "file",
    pathname: target,
    fragment: null,
    tx: JSON.stringify({ target: target === null ? null : { raw: target }, body }),
    rx: null,
    attrs: JSON.stringify({ stream }),
    status_rx: 200,
    origin: "model",
});
const receipt = (output = "GREETING\n", exitCode = 0, source = stream): ScriptReceipt => ({
    scheme: "sh",
    pathname: new URL(source).pathname,
    fragment: "stdout",
    tx: "{}",
    rx: JSON.stringify({ content: output, exitCode, terminal: true }),
    attrs: JSON.stringify({ streamEnd: output.length }),
    status_rx: 200,
    origin: "_plurnk",
});

test("{§tier-corpus} packet audit oracle accepts numbered findings with Markdown emphasis", () => {
    for (const answer of [
        "1. The roster is inconsistent.",
        "## 1. The roster is inconsistent.",
        "**1. The roster is inconsistent.**\n\nThe two files disagree.",
        "**1.** The roster is inconsistent.",
        "Findings:\n\n2) The dependency is missing.",
        "I did not find any material errors.",
        "No findings.",
    ]) assert.equal(hasAuditOutcome(answer), true, answer);
    for (const answer of ["", "1.", "**1.**", "I will inspect the packet.", "There are 2 files."]) {
        assert.equal(hasAuditOutcome(answer), false, answer);
    }
});

test("{§tier-corpus} script oracle accepts native script execution and shell commands with observed successful output", () => {
    for (const exec of [execution("greet.sh"), execution(null, "sh ./greet.sh"), execution(null, "chmod +x greet.sh && ./greet.sh")]) {
        assert.equal(observedScriptExecution([exec], [receipt()], "greet.sh", "GREETING"), true);
    }
});

test("{§tier-corpus} a model that verifies around the run is not failed for it", () => {
    const verified = "-rwxr-xr-x 1 u u 31 Sep 21 20:00 greet.sh\nGREETING\nexit=0\n";
    assert.equal(
        observedScriptExecution([execution(null, 'ls -l greet.sh; sh greet.sh; echo "exit=$?"')], [receipt(verified)], "greet.sh", "GREETING"),
        true,
    );
    for (const embedded of ["say GREETING\n", "GREETINGS\n", "xGREETING\n"]) {
        assert.equal(observedScriptExecution([execution("greet.sh")], [receipt(embedded)], "greet.sh", "GREETING"), false, embedded);
    }
});

test("{§tier-corpus} script oracle rejects claimed, unobserved, failed, unrelated and mismatched executions", () => {
    const cases: Array<[ScriptReceipt[], ScriptReceipt[]]> = [
        [[], []],
        [[execution("greet.sh")], []],
        [[execution("greet.sh")], [receipt("GREETING\n", 1)]],
        [[execution("greet.sh")], [receipt("WRONG\n")]],
        [[execution(null, "printf GREETING")], [receipt()]],
        [[execution("greet.sh")], [receipt("GREETING\n", 0, "sh:///1/2/4/sh")]],
        [[{ ...execution("greet.sh"), status_rx: 403 }], [receipt()]],
        [[execution("greet.sh")], [{ ...receipt(), rx: JSON.stringify({ content: "GREETING\n", exitCode: 0, terminal: false }) }]],
        [[execution("greet.sh")], [{ ...receipt(), fragment: "stderr" }]],
    ];
    for (const [execs, reads] of cases) assert.equal(observedScriptExecution(execs, reads, "greet.sh", "GREETING"), false);
});

test("{§tier-corpus} web story oracle distinguishes latest stable from a newer maintenance date or an LTS label", () => {
    assert.equal(
        latestStableNodeVersion([
            { version: "v24.99.2", lts: "Example" },
            { version: "v26.9.2", lts: false },
            { version: "v27.0.0-rc.1", lts: false },
            { version: "v26.10.1", lts: false },
            { version: "v26.10.2", lts: false },
        ]),
        "v26.10.2",
    );
    for (const malformed of [null, {}, [], [{}], [{ version: 26 }], [{ version: "v27.0.0-rc.1" }]]) {
        assert.throws(() => latestStableNodeVersion(malformed), { name: "AssertionError" });
    }
});

test("{§tier-corpus} web story oracle requires the actual version, not arbitrary digits or a partial match", () => {
    for (const answer of ["Node.js **v26.10.2** is the latest stable release.", "The latest stable is 26.10.2."]) {
        assert.equal(namesNodeVersion(answer, "v26.10.2"), true);
    }
    for (const answer of ["26", "v24.99.2 LTS", "v26.10.20", "v126.10.2", "v26.10.2-rc.1", "I searched the web."]) {
        assert.equal(namesNodeVersion(answer, "v26.10.2"), false, answer);
    }
});

test("{§tier-corpus} the retrieval oracle collects every non-prerelease version a text names", () => {
    assert.deepEqual([...versionsNamed("Node.js 26.9.0 (Current) — also v26.10.0-rc.1 and 24.11.1 LTS.")], ["v26.9.0", "v24.11.1"]);
    assert.deepEqual([...versionsNamed("I searched the web.")], []);
});
}
