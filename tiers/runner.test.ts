import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    buildTierInvocation,
    publishTierSessions,
    selectTierSpecimens,
    tierFiles,
    tierRunDir,
} from "./runner.ts";

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
