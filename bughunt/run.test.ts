import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { runLeg } from "./run.ts";

test("[§bughunt-trial] preflight confirms prompt readiness without executing candidate", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bughunt-run-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const result = await runLeg({
        task: "repo1",
        sourceRepo: "",
        model: "deepdumb",
        turnCap: 100,
        timeout: 60,
        preflight: true,
        noPublish: true,
    });

    assert.equal(result.task, "repo1");
    assert.ok(existsSync(result.trialDir));
    assert.equal(result.exit.status, 0);
});

test("[§bughunt-trial] runLeg executes, generates trial artifacts and evaluates", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "bughunt-mock-run-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const sourceRepo = join(root, "source-repo");
    mkdirSync(sourceRepo, { recursive: true });
    writeFileSync(join(sourceRepo, "index.ts"), "const x = 1;\n");

    // Mock plurnk binary in a local bin directory
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const mockPlurnk = join(binDir, "plurnk");
    writeFileSync(
        mockPlurnk,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
// Emulate plurnk client creating a change and emitting json
const root = process.argv.indexOf('--project-root');
const targetDir = root !== -1 ? process.argv[root + 1] : process.cwd();
fs.writeFileSync(path.join(targetDir, 'index.ts'), 'const x = 2; // bug fixed\\n');
fs.writeFileSync(path.join(targetDir, 'BUGS_FOUND.md'), '# BUGS FOUND\\n1. Fixed x value\\n');
console.log(JSON.stringify({ schemaVersion: 6, finalStatus: 200, turnCount: 5, wallMs: 1500 }));
`,
        { mode: 0o755 },
    );

    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}:${originalPath}`;
    t.after(() => {
        process.env.PATH = originalPath;
    });

    const result = await runLeg({
        task: "repo1",
        sourceRepo,
        model: "deepdumb",
        turnCap: 50,
        timeout: 30,
        mockScore: 18,
        noPublish: true,
    });

    assert.equal(result.exit.status, 0);
    assert.ok(existsSync(join(result.trialDir, "result.json")));
    assert.ok(existsSync(join(result.trialDir, "provenance.json")));
    assert.ok(existsSync(join(result.trialDir, "artifacts", "model.patch")));
    assert.ok(existsSync(join(result.trialDir, "artifacts", "BUGS_FOUND.md")));
    assert.ok(existsSync(join(result.trialDir, "agent", "plurnk.json")));
    assert.ok(existsSync(join(result.trialDir, "verifier", "reward.json")));
    assert.ok(existsSync(join(result.trialDir, "verifier", "evaluation.json")));

    const reward = JSON.parse(readFileSync(join(result.trialDir, "verifier", "reward.json"), "utf8"));
    assert.equal(reward.f2p_total, 45);
    assert.equal(reward.f2p_passed, 18);
    assert.equal(reward.partial, 0.4);

    const provenance = JSON.parse(readFileSync(join(result.trialDir, "provenance.json"), "utf8"));
    assert.equal(provenance.benchmark, "bughunt");
    assert.equal(provenance.task, "repo1");
    assert.equal(provenance.model, "deepdumb");
});

test("[§bughunt-trial] CLI invocation rejects invalid arguments", () => {
    const runTs = new URL("./run.ts", import.meta.url).pathname;

    const invalidTask = spawnSync(process.execPath, [runTs, "--task", "invalid"], {
        encoding: "utf8",
    });
    assert.equal(invalidTask.status, 1);
    assert.match(invalidTask.stderr, /Invalid --task 'invalid'/);

    const missingRepo = spawnSync(process.execPath, [runTs, "--task", "repo1"], {
        encoding: "utf8",
        env: { ...process.env, PLURNK_BUGHUNT_REPO1: "" },
    });
    assert.equal(missingRepo.status, 1);
    assert.match(missingRepo.stderr, /Missing repository path for repo1/);
});
