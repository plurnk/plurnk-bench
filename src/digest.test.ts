import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { digestDirFor, renderDigest } from "./digest.ts";
import type { BenchRecord } from "./record.ts";

// The artifact lives beside the trial's agent/ dir: <trial>/agent/plurnk.db → <trial>/digest.
test("digestDirFor puts the artifact at <trial>/digest, beside agent/", () => {
    assert.equal(
        digestDirFor(join("jobs", "j", "task__abc", "agent", "plurnk.db")),
        join("jobs", "j", "task__abc", "digest"),
    );
});

// No run handle (no DB was copied) → nothing to render; bench never fabricates one. The
// Digest.run render itself is the daughter's boundary, validated against real run DBs.
test("renderDigest returns null when the record has no run handle", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "t", model: "m",
        durationMs: 0, status: 0, outcome: "error", turns: 0,
    };
    assert.equal(renderDigest(record), null);
});
