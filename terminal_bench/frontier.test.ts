import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADROOM_SEC, median, plan, readManifest, summary, tomlValue } from "./frontier.mjs";

const TOML = `schema_version = "1.1"

[task]
name = "terminal-bench/chess-best-move"

[verifier]
timeout_sec = 900.0

[agent]
timeout_sec = 900.0

[environment]
build_timeout_sec = 600.0
docker_image = "alexgshaw/chess-best-move:20251031"
`;

const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "frontier-"));
    for (const task of ["tb-one", "ds-one"]) {
        mkdirSync(join(root, "cache", task), { recursive: true });
        writeFileSync(join(root, "cache", task, "task.toml"), task === "ds-one" ? TOML.replace("timeout_sec = 900.0\n\n[environment]", "timeout_sec = 5400.0\n\n[environment]") : TOML);
    }
    const manifest = join(root, "manifest.json");
    writeFileSync(manifest, JSON.stringify({
        terminal_bench: { cache: join(root, "cache"), tasks: ["tb-one"] },
        deep_swe: { cache: join(root, "cache"), tasks: ["ds-one"] },
    }));
    return { root, manifest };
};

test("[§frontier-parity] the checked-in manifest names 21 Terminal-Bench 2.1 and 9 DeepSWE tasks, each once", () => {
    const { manifest, tasks } = readManifest();
    assert.equal(manifest.terminal_bench.tasks.length, 21);
    assert.equal(manifest.deep_swe.tasks.length, 9);
    assert.equal(tasks.length, 30);
    assert.equal(manifest.model.route, "fireworks-ai/accounts/fireworks/models/kimi-k3");
});

test("[§frontier-parity] task.toml facts read by section: the agent budget, not the verifier's", () => {
    assert.equal(tomlValue(TOML, "agent", "timeout_sec"), "900.0");
    assert.equal(tomlValue(TOML, "environment", "docker_image"), "alexgshaw/chess-best-move:20251031");
    assert.equal(tomlValue(TOML, "solution", "timeout_sec"), null);
});

test("[§frontier-parity] the plan carries each task's own budget minus headroom and its image", () => {
    const { manifest } = fixture();
    const rows = plan(manifest);
    assert.deepEqual(rows.map(({ task, budget, client_timeout_sec }) => ({ task, budget, client_timeout_sec })), [
        { task: "tb-one", budget: 900, client_timeout_sec: 900 - HEADROOM_SEC },
        { task: "ds-one", budget: 5400, client_timeout_sec: 5400 - HEADROOM_SEC },
    ]);
    assert.equal(rows[0]?.image, "alexgshaw/chess-best-move:20251031");
});

test("[§frontier-parity] a manifest task without a corpus directory stops the plan by name", () => {
    const { root, manifest } = fixture();
    writeFileSync(manifest, JSON.stringify({
        terminal_bench: { cache: join(root, "cache"), tasks: ["tb-one", "tb-absent"] },
        deep_swe: { cache: join(root, "cache"), tasks: [] },
    }));
    assert.throws(() => plan(manifest), /terminal_bench\/tb-absent: no task at/);
});

test("[§frontier-parity] the summary reads Harbor's reward.txt per job and counts pass, fail, and missing", () => {
    const { root, manifest } = fixture();
    const run = join(root, "run");
    mkdirSync(join(run, "tb-one", "tb-one__abc", "verifier"), { recursive: true });
    writeFileSync(join(run, "tb-one", "tb-one__abc", "verifier", "reward.txt"), "1.0\n");
    mkdirSync(join(run, "ds-one", "ds-one__def", "verifier"), { recursive: true });
    writeFileSync(join(run, "ds-one", "ds-one__def", "verifier", "reward.txt"), "0\n");
    const result = summary(run, manifest);
    assert.deepEqual(result.rows.map(({ task, verdict }) => ({ task, verdict })), [{ task: "tb-one", verdict: "pass" }, { task: "ds-one", verdict: "fail" }]);
    assert.equal(result.passed, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.missing, 0);
    assert.deepEqual(result.terminal_bench, { passed: 1, total: 1 });
    writeFileSync(manifest, JSON.stringify({
        terminal_bench: { cache: join(root, "cache"), tasks: ["tb-one"] },
        deep_swe: { cache: join(root, "cache"), tasks: ["ds-one", "ds-two"] },
    }));
    assert.equal(summary(run, manifest).missing, 1, "a task with no trial dir is missing, never a fail");
});

test("[§frontier-parity] the summary reports task-level success, cost, cache, and duration medians", () => {
    const { root, manifest } = fixture();
    const run = join(root, "run");
    const writeTrial = (task: string, reward: number, costUsd: string, inputTokens: number, cacheReadTokens: number, wallMs: number) => {
        const trial = join(run, task, `${task}__trial`);
        mkdirSync(join(trial, "verifier"), { recursive: true });
        mkdirSync(join(trial, "agent"), { recursive: true });
        writeFileSync(join(trial, "verifier", "reward.txt"), `${reward}\n`);
        writeFileSync(join(trial, "agent", "plurnk.json"), JSON.stringify({
            usage: {
                accounting: {
                    costUsd,
                    usage: { inputTokens, inputTokenDetails: { cacheReadTokens } },
                },
            },
        }));
        const started = new Date("2026-09-04T12:00:00.000Z");
        writeFileSync(join(trial, "result.json"), JSON.stringify({
            started_at: started.toISOString(),
            finished_at: new Date(started.getTime() + wallMs).toISOString(),
        }));
    };
    writeTrial("tb-one", 1, "0.50", 1_000, 800, 240_000);
    writeTrial("ds-one", 0, "1.50", 2_000, 1_000, 480_000);

    const result = summary(run, manifest);
    assert.equal(result.metrics.passRate, 0.5);
    assert.deepEqual(result.metrics.medianCostPerSuccessfulTaskUsd, { value: 0.5, reported: 1, eligible: 1 });
    assert.deepEqual(result.metrics.medianCostPerTaskUsd, { value: 1, reported: 2, eligible: 2 });
    assert.deepEqual(result.metrics.medianCacheHitRatePerSuccessfulTask, { value: 0.8, reported: 1, eligible: 1 });
    assert.deepEqual(result.metrics.medianTimePerSuccessfulTaskMs, { value: 240_000, reported: 1, eligible: 1 });
});

test("[§frontier-parity] medians are task-weighted and average the middle pair", () => {
    assert.equal(median([]), null);
    assert.equal(median([9, 1, 5]), 5);
    assert.equal(median([10, 2, 8, 4]), 6);
});

test("[§frontier-parity] an active trial's empty client document is missing telemetry, not malformed evidence", () => {
    const { root, manifest } = fixture();
    const trial = join(root, "run", "tb-one", "tb-one__active");
    mkdirSync(join(trial, "agent"), { recursive: true });
    writeFileSync(join(trial, "agent", "plurnk.json"), "");
    const result = summary(join(root, "run"), manifest);
    assert.deepEqual(result.metrics.medianCostPerTaskUsd, { value: null, reported: 0, eligible: 0 });
});
