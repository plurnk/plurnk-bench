import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { digestDirFor, readDigest, renderDigest } from "./digest.ts";
import type { BenchRecord } from "./record.ts";

// The artifact lives beside the trial's agent/ dir: <trial>/agent/plurnk.db → <trial>/digest.
test("[§digest-boundary] digestDirFor puts the artifact at <trial>/digest, beside agent/", () => {
    assert.equal(
        digestDirFor(join("jobs", "j", "task__abc", "agent", "plurnk.db")),
        join("jobs", "j", "task__abc", "digest"),
    );
});

// No run handle (no DB was copied) → nothing to render; bench never fabricates one. The
// Digest.run render itself is the daughter's boundary, validated against real run DBs.
test("[§digest-boundary] renderDigest returns null when the record has no run handle", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "t", model: "m",
        durationMs: 0, status: 0, outcome: "error", turns: 0,
    };
    assert.equal(renderDigest(record), null);
});

test("[§digest-boundary] reporting retains summaries without retaining raw model responses", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bench-digest-reader-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "digest.json");
    const facts = {
        workspaces: [{ accounting: { costUsd: "0.123", requests: [], usage: null } }],
        workers: [{ id: 1, name: "日本語" }], loops: [], turns: [{ producer: "model" }],
        provider_requests: [], log_entries: [],
    };
    writeFileSync(path, JSON.stringify({ ...facts, model_calls: [{ response: "opaque" }], turn_attempts: [
        { accepted: false, parse_errors: [{ message: "not admitted" }], response: { assistantRaw: "retained on disk" } },
    ] }));
    assert.deepEqual(readDigest(path), { ...facts, turn_attempts: [{ accepted: false, parse_errors: [{ message: "not admitted" }] }] });
    writeFileSync(path, '{"workspaces":[],"turn_attempts":[]}');
    assert.deepEqual(readDigest(path), { workspaces: [], turn_attempts: [] });
    writeFileSync(path, '{"turns":[');
    assert.throws(() => readDigest(path), /Parser ended in mid-parsing \(state: VALUE\)/);
});

test("[§digest-boundary] a report larger than the reader heap is inspected incrementally", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bench-digest-large-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "digest.json");
    const descriptor = openSync(path, "w");
    try {
        writeSync(descriptor, '{"turns":[{"producer":"model"}],"model_calls":[');
        const row = JSON.stringify({ response: { reasoning: "😀".repeat(512 * 1024) } });
        for (let index = 0; index < 32; index++) writeSync(descriptor, `${index === 0 ? "" : ","}${row}`);
        writeSync(descriptor, '],"turn_attempts":[{"accepted":true,"response":');
        writeSync(descriptor, row);
        writeSync(descriptor, '}],"workspaces":[]}');
    } finally { closeSync(descriptor); }
    const stdout = execFileSync(process.execPath, ["--max-old-space-size=64", "--input-type=module", "--eval", `
        import { readDigest } from ${JSON.stringify(new URL("./digest.ts", import.meta.url).href)};
        console.log(JSON.stringify(readDigest(${JSON.stringify(path)})));
    `], { encoding: "utf8", timeout: 20000 });
    assert.deepEqual(JSON.parse(stdout), { turns: [{ producer: "model" }], turn_attempts: [{ accepted: true }], workspaces: [] });
});
