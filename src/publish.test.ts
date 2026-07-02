import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { nextRunNumber, publishRun, defaultBenchmarksDir, digestHasTurns } from "./publish.ts";
import type { BenchRecord } from "./record.ts";

// run<N> auto-increments off the highest existing run, ignoring non-run dirs.
test("nextRunNumber picks max(runN)+1, else 1", () => {
    const root = mkdtempSync(join(tmpdir(), "bench-pub-"));
    try {
        assert.equal(nextRunNumber(root), 1);                 // empty tree
        assert.equal(nextRunNumber(join(root, "nope")), 1);   // missing tree
        mkdirSync(join(root, "run1"));
        mkdirSync(join(root, "run4"));
        mkdirSync(join(root, "notes"));                       // ignored
        assert.equal(nextRunNumber(root), 5);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// No run handle (no DB copied) → nothing to publish; bench never fabricates a run dir.
test("publishRun returns null when the record has no run handle", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "t", model: "m",
        durationMs: 0, status: 0, outcome: "error", turns: 0,
    };
    assert.equal(publishRun(record, mkdtempSync(join(tmpdir(), "bench-pub-"))), null);
});

// An infra-failure run (turn-less DB) must not be published — gated on the digest.
test("digestHasTurns is false for an absent or empty digest, true with turns", () => {
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

// The shared tree is a sibling of the bench repo.
test("defaultBenchmarksDir resolves to a sibling 'benchmarks' dir", () => {
    assert.match(defaultBenchmarksDir(), /\/benchmarks$/);
    assert.doesNotMatch(defaultBenchmarksDir(), /plurnk-bench\/benchmarks$/);
});
