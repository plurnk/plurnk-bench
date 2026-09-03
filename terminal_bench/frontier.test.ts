import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEADROOM_SEC, plan, readManifest, summary, tomlValue } from "./frontier.mjs";

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
