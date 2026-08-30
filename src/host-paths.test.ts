import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";
import {
    benchmarksHome,
    jobsRoot,
    loadBenchmarkEnvironment,
    operatorConfigPath,
    selectedModel,
} from "./host-paths.ts";

test("operatorConfigPath follows XDG while preserving an explicit bench override", () => {
    assert.equal(operatorConfigPath(undefined, {}, "/home/ada"), "/home/ada/.config/plurnk/.env");
    assert.equal(
        operatorConfigPath(undefined, { XDG_CONFIG_HOME: "/cfg" }, "/home/ada"),
        "/cfg/plurnk/.env",
    );
    assert.equal(
        operatorConfigPath(undefined, { XDG_CONFIG_HOME: "relative" }, "/home/ada"),
        "/home/ada/.config/plurnk/.env",
    );
    assert.equal(operatorConfigPath("~/operator.env", {}, "/home/ada"), "/home/ada/operator.env");
    assert.equal(operatorConfigPath("/run/operator.env", {}, "/home/ada"), "/run/operator.env");
});

test("[§results-canon] jobsRoot keeps every harness's job scratch under the benchmarks home", () => {
    assert.equal(benchmarksHome({}, "/home/ada"), "/home/ada/benchmarks");
    assert.equal(jobsRoot("enterprise", {}, "/home/ada"), "/home/ada/benchmarks/jobs/enterprise");
    assert.equal(jobsRoot("deepswe", { PLURNK_BENCH_HOME: "/srv/bench" }, "/home/ada"), "/srv/bench/jobs/deepswe");
});

test("[§config-model-default] benchmark environment loads operator config before committed defaults", (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-bench-env-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const operator = resolve(root, "operator.env");
    const defaults = resolve(root, "defaults.env");
    writeFileSync(operator, "PLURNK_MODEL=operator\n");
    writeFileSync(defaults, "PLURNK_MODEL=default\n");
    const loadInto = (env: NodeJS.ProcessEnv, loaded: string[]) => (path: string) => {
        loaded.push(path);
        for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
            if (env[key] === undefined) env[key] = value;
        }
    };
    const operatorSelected: NodeJS.ProcessEnv = {};
    const operatorLoaded: string[] = [];

    const resolved = loadBenchmarkEnvironment(
        operator,
        defaults,
        operatorSelected,
        loadInto(operatorSelected, operatorLoaded),
    );

    assert.equal(resolved, operator);
    assert.deepEqual(operatorLoaded, [operator, defaults]);
    assert.equal(selectedModel(operatorSelected), "operator", "XDG operator config wins over defaults");

    const shellSelected: NodeJS.ProcessEnv = { PLURNK_MODEL: "shell" };
    loadBenchmarkEnvironment(operator, defaults, shellSelected, loadInto(shellSelected, []));
    assert.equal(selectedModel(shellSelected), "shell", "the invoking shell wins over both files");

    const defaultSelected: NodeJS.ProcessEnv = {};
    loadBenchmarkEnvironment(resolve(root, "absent.env"), defaults, defaultSelected, loadInto(defaultSelected, []));
    assert.equal(selectedModel(defaultSelected), "default", "the committed floor fills an unset selection");
});

test("[§config-model-default] the candidate selection is the ordinary PLURNK_MODEL", () => {
    assert.equal(selectedModel({ PLURNK_MODEL: "deepdumb" }), "deepdumb");
    assert.equal(selectedModel({ PLURNK_MODEL: " cloudflare/@cf/qwen/qwen3.8-27b " }), "cloudflare/@cf/qwen/qwen3.8-27b");
    assert.throws(() => selectedModel({}), /PLURNK_MODEL/);
    assert.throws(() => selectedModel({ PLURNK_MODEL: " " }), /PLURNK_MODEL/);
});
