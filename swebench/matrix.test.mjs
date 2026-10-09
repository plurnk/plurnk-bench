import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planMatrix, runMatrix } from "./matrix.mjs";
import { frictionOf } from "./friction.ts";

const profiles = ["a", "b", "c"].map((name) => ({ name, env: { PLURNK_SERVICE_EMISSION_HISTORY: name } }));
const row = (over = {}) => ({
    instance: "specimen", attempt: 1, model: "selected", outcome: "pass", loopStatus: 200, reward: 1,
    emptyPatch: false, exception: null, evaluation: null, turns: 1, requests: 1, rejectedEmissions: 0,
    tokens: { input: 100, cached: 50, output: 20, reasoning: 10 }, costUsd: 0.01, knownCostUsd: 0.01,
    pricedRequests: 1, costEvidence: { charged: 0, estimated: 1, unknown: 0 }, wallMs: 10,
    friction: frictionOf(null), webReferences: 0, webAttempts: 0, webReads: 0, mcpCalls: 0, edits: null, evidence: "fixture", ...over,
});
const fixture = (t) => {
    const out = mkdtempSync(join(tmpdir(), "swebench-matrix-"));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    return { profiles, attempts: 2, jobs: 1, out, instances: ["specimen"], model: "selected", env: { PRESERVED: "yes" }, provenance: { serviceHead: "exact" } };
};

test("{§swebench-matrix}: every profile runs once per repetition in rotating order, without omissions", () => {
    assert.deepEqual(planMatrix(profiles, 2, ["specimen"]), [
        { profile: "a", attempt: 1 }, { profile: "b", attempt: 1 }, { profile: "c", attempt: 1 },
        { profile: "b", attempt: 2 }, { profile: "c", attempt: 2 }, { profile: "a", attempt: 2 },
    ].map((trial) => ({ instance: "specimen", ...trial })));
    assert.throws(() => planMatrix([profiles[0], profiles[0]], 1, ["specimen"]), /unique lowercase/);
    assert.throws(() => planMatrix(profiles, 0, ["specimen"]), /positive integer/);
    assert.throws(() => planMatrix([{ name: "bad", env: { PLURNK_SERVICE_REASONING_ROWS: 0 } }], 1, ["specimen"]), /string values/);
    const packet = JSON.parse(readFileSync(new URL("./profiles/packet-memory.json", import.meta.url), "utf8"));
    assert.equal(planMatrix(packet, 3, ["specimen"]).length, 27);
    assert.equal(new Set(packet.map(({ env }) => JSON.stringify(env))).size, 9);
    assert.ok(packet.every(({ env }) => Object.keys(env).every((name) => ["PLURNK_SERVICE_REASONING_ROWS", "PLURNK_SERVICE_REASONING_TRAILING_LINES", "PLURNK_SERVICE_EMISSION_HISTORY"].includes(name))));
});

test("{§swebench-matrix}: a corpus pairs every profile and repetition without duplicate purchases", () => {
    const { instances } = JSON.parse(readFileSync(new URL("./corpora/harnesstax-swe-lite-30.json", import.meta.url), "utf8"));
    const plan = planMatrix(profiles.slice(0, 2), 3, instances);
    assert.equal(plan.length, 180);
    assert.equal(new Set(plan.map(({ instance, profile, attempt }) => `${instance}/${profile}/${attempt}`)).size, 180);
    for (const instance of instances) {
        for (const profile of profiles.slice(0, 2)) {
            assert.deepEqual(plan.filter((trial) => trial.instance === instance && trial.profile === profile.name).map(({ attempt }) => attempt), [1, 2, 3]);
        }
    }
    assert.deepEqual(plan.slice(0, 4).map(({ instance, profile, attempt }) => [instance, profile, attempt]), [
        [instances[0], "a", 1], [instances[0], "b", 1], [instances[1], "b", 1], [instances[1], "a", 1],
    ]);
    assert.equal(plan[60].profile, "b", "the next repetition reverses the first task's profile order");
    for (const invalid of [[], ["same", "same"], [null], [" "]]) {
        assert.throws(() => planMatrix(profiles, 3, invalid), /unique nonempty identifiers/);
    }
});

test("{§swebench-matrix}: each corpus trial receives its own instance and frozen source profile", async (t) => {
    const input = { ...fixture(t), instances: ["one", "two"], attempts: 1,
        profiles: ["a", "b"].map((name) => ({ name, env: { PLURNK_SWEBENCH_SERVICE_ROOT: `/frozen/${name}` } })),
    };
    const calls = [];
    const results = await runMatrix(input, async (_command, args, options) => {
        calls.push([args[1], options.env.PLURNK_SWEBENCH_SERVICE_ROOT]);
        writeFileSync(options.stdoutPath, `artifact=${args[1]}\n`);
        return { status: 0 };
    }, (artifact, attempt) => ({ verdict: "pass", row: row({ instance: artifact, attempt }) }));
    assert.deepEqual(calls, [["one", "/frozen/a"], ["one", "/frozen/b"], ["two", "/frozen/b"], ["two", "/frozen/a"]]);
    assert.deepEqual(results.map(({ instance }) => instance), ["one", "one", "two", "two"]);
    const launches = readFileSync(join(input.out, "launches.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(launches.length, 4);
    assert.equal(new Set(launches.map(({ instance, profile, attempt }) => `${instance}/${profile}/${attempt}`)).size, 4);
});

test("{§swebench-matrix}: the ordinary runner receives exact profiles; misses and their costs remain in reports", async (t) => {
    const input = fixture(t);
    const calls = [];
    const results = await runMatrix(input, async (command, args, options) => {
        assert.ok(command.endsWith("/swebench/run.sh"));
        assert.deepEqual(args, ["--instance", "specimen", "--model", "selected"]);
        assert.equal(options.env.PRESERVED, "yes");
        assert.equal(options.signal, undefined, "matrix orchestration does not cancel requests");
        calls.push(options.env.PLURNK_SERVICE_EMISSION_HISTORY);
        writeFileSync(options.stdoutPath, `artifact=${calls.length}\n`);
        return { status: 1 };
    }, (artifact, attempt) => ({ verdict: "fail: reward 0", row: row({ attempt, reward: 0, outcome: "fail", evidence: artifact }) }));
    assert.deepEqual(calls, ["a", "b", "c", "b", "c", "a"]);
    assert.equal(results.length, 6);
    const summary = JSON.parse(readFileSync(join(input.out, "summary.json"), "utf8"));
    assert.equal(summary.finished, 6);
    assert.ok(summary.profiles.every((profile) => profile.graded === 2 && profile.resolved === 0 && profile.spend.totalUsd === 0.02));
    const plan = JSON.parse(readFileSync(join(input.out, "plan.json"), "utf8"));
    assert.deepEqual(plan.profiles, profiles);
    assert.deepEqual(plan.provenance, input.provenance);
    await assert.rejects(runMatrix(input), { code: "EEXIST" }, "a prior experiment cannot be overwritten or silently repurchased");
});

test("{§swebench-matrix}: infrastructure failure stops new launches while in-flight work finishes", async (t) => {
    const input = { ...fixture(t), jobs: 2 };
    const settle = Promise.withResolvers();
    let launched = 0;
    let finished = 0;
    const run = runMatrix(input, async (_command, _args, options) => {
        const index = ++launched;
        if (index === 2) await settle.promise;
        writeFileSync(options.stdoutPath, index === 1 ? "setup failure\n" : "artifact=good\n");
        finished++;
        return { status: index === 1 ? 1 : 0 };
    }, () => ({ verdict: "pass", row: row() }));
    const rejected = assert.rejects(run, /in-flight trials settled/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(launched, 2);
    assert.equal(finished, 1);
    settle.resolve();
    await rejected;
    assert.equal(finished, 2);
    const summary = JSON.parse(readFileSync(join(input.out, "summary.json"), "utf8"));
    assert.equal(summary.halted, true);
    assert.equal(summary.profiles[0].missingEvidence, 1);
    assert.equal(summary.profiles[0].spend.totalUsd, null, "missing evidence is not free inference");
    assert.equal(summary.profiles[1].spend.totalUsd, 0.01);
});
