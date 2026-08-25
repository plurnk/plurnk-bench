import assert from "node:assert/strict";
import test from "node:test";
import { benchmarksHome, jobsRoot, operatorConfigPath } from "./host-paths.ts";

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
