import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
    defaultBenchmarksDir,
    digestHasTurns,
    runLabels,
    digestHasModelTurns,
    publishRun,
    publishedRecord,
} from "./publish.ts";
import type { BenchRecord } from "./record.ts";
import { allocateRunDirectory } from "./run-directory.ts";
import { benchmarksHome } from "./host-paths.ts";

// run<N> auto-increments off the highest existing run, ignoring non-run dirs.
test("[§publish-numbering] a published run is named run<N>-<harness>-<task>-<model>, N continuing the tree", () => {
    const labels = runLabels({ harness: "enterprise", taskId: "Enterprise-Bench/eng-l1-a", model: "plurnk/deepdumb" } as BenchRecord);
    assert.deepEqual(labels, ["enterprise", "eng-l1-a", "deepdumb"]);
    const root = mkdtempSync(join(tmpdir(), "bench-pub-"));
    try {
        mkdirSync(join(root, "run21-deepswe-abs-module-cache-flags-deepdumb"));
        const dir = allocateRunDirectory(root, labels);
        assert.equal(dir, join(root, "run22-enterprise-eng-l1-a-deepdumb"));
        assert.deepEqual(readdirSync(root).toSorted(), ["run21-deepswe-abs-module-cache-flags-deepdumb", "run22-enterprise-eng-l1-a-deepdumb"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("[§publish] publishRun returns null when the record has no run handle", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "t", model: "m",
        durationMs: 0, status: 0, outcome: "error", turns: 0,
    };
    assert.equal(publishRun(record, mkdtempSync(join(tmpdir(), "bench-pub-"))), null);
});

test("[§publish-model-attempt-gate] the DB's own model turn defines a benchmark attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-digest-"));
    try {
        assert.equal(digestHasModelTurns(dir), false);                                                           // no digest.json
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [{ producer: "_plurnk", kind: "initialization" }] }));
        assert.equal(digestHasModelTurns(dir), false);                                                           // setup only
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [{ producer: "_plurnk" }, { producer: "model", kind: "inference" }] }));
        assert.equal(digestHasModelTurns(dir), true);                                                            // a client record that died mid-loop still counts
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("[§publish-turnless-gate] digestHasTurns is false for an absent or empty digest, true with turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-dig-"));
    try {
        assert.equal(digestHasTurns(dir), false);                                   // no digest.json
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [] }));
        assert.equal(digestHasTurns(dir), false);                                   // empty loop
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [{ sequence: 1 }] }));
        assert.equal(digestHasTurns(dir), true);                                    // real loop
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// record.json makes benchmarks/run<N> self-sufficient: it re-points the digest handle at the
// published DB and carries the oracle side (reward/outcome/filesModified) the DB+digest lack.
test("[§publish-self-referential] publishedRecord re-points the DB handle and preserves the oracle fields", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "abs-module-cache-flags", model: "plurnk/gbuild",
        durationMs: 1000, status: 499, outcome: "timeout", turns: 15,
        reward: 0, filesModified: 1, p2pRegressed: true, testPassFraction: 0.13,
        run: { dbPath: "/jobs/scratch/agent/plurnk.db", workerId: 7, workspaceId: 1, loopId: 8 },
    };
    const published = publishedRecord(record, "/benchmarks/run9/plurnk.db");
    assert.equal(published.run!.dbPath, "/benchmarks/run9/plurnk.db");   // self-referential, not jobs/
    assert.equal(published.run!.workerId, 7);                             // handle otherwise intact
    // the oracle side that forced reads back to jobs/ now travels with the published record
    assert.equal(published.reward, 0);
    assert.equal(published.outcome, "timeout");
    assert.equal(published.filesModified, 1);
    assert.equal(published.p2pRegressed, true);
    assert.equal(record.run!.dbPath, "/jobs/scratch/agent/plurnk.db");   // input not mutated
});

// The shared tree is a sibling of the bench repo.
test("[§results-canon] the one benchmarks home is ~/benchmarks unless PLURNK_BENCH_HOME says otherwise", () => {
    assert.equal(benchmarksHome({}, "/home/ada"), "/home/ada/benchmarks");
    assert.equal(benchmarksHome({ PLURNK_BENCH_HOME: "~/runs" }, "/home/ada"), "/home/ada/runs");
    assert.equal(benchmarksHome({ PLURNK_BENCH_HOME: "/srv/bench" }, "/home/ada"), "/srv/bench");
    assert.equal(benchmarksHome({ PLURNK_BENCH_HOME: "  " }, "/home/ada"), "/home/ada/benchmarks");
    assert.match(defaultBenchmarksDir(), /\/benchmarks$/);
    assert.doesNotMatch(defaultBenchmarksDir(), /plurnk-bench\/benchmarks$|\/ptl\/benchmarks$/);
});

test("[§publish-requiem] the requiem is banked only on PLURNK_BENCH_REQUIEM=1", () => {
    const source = readFileSync(new URL("./publish.ts", import.meta.url), "utf8");
    assert.match(source, /if \(process\.env\.PLURNK_BENCH_REQUIEM === "1"\) \{\s*try \{\s*await Digest\.requiem\(/);
    assert.equal((source.match(/Digest\.requiem\(/g) ?? []).length, 1);
});
