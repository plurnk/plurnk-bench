import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { readTrialRow } from "./report.ts";
import { frictionOf, summarizeFriction } from "./friction.ts";

const noOperation = "https://problems.plurnk.xyz/engine/rail/no-operation";
const nonzero = "https://problems.plurnk.xyz/executor/subprocess/nonzero-exit";
const range = "https://problems.plurnk.xyz/scheme/file/range";

const entry = (over: Record<string, unknown> = {}) => ({
    id: 1, turn_id: 1, worker_id: 1, origin: "model", source: null,
    inherited_history: false, ambient_event_id: null, attrs: {}, op: "READ",
    target: "file.txt", status_rx: 200, ...over,
});

const trial = (t: TestContext, turns: Array<{ id: number; program?: string | null }>, entries: object[]) => {
    const root = mkdtempSync(join(tmpdir(), "swebench-friction-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "agent", "digest"), { recursive: true });
    mkdirSync(join(root, "verifier"));
    const write = (file: string, value: unknown) => writeFileSync(join(root, file), JSON.stringify(value));
    write("result.json", { trial_name: "fixture", task_name: "fixture" });
    write("agent/plurnk.json", { schemaVersion: 6, finalStatus: 200, wallMs: 10 });
    write("verifier/reward.json", { reward: 1 });
    const savedTurns = turns.map((turn) => {
        const artifact = `worker-1-${turn.id}`;
        if (typeof turn.program === "string") writeFileSync(join(root, "agent", "digest", `${artifact}.assistant.md`), turn.program);
        return { ...turn, artifact };
    });
    write("agent/digest/digest.json", {
        workspaces: [{ accounting: { requests: [], costUsd: "0", usage: null } }],
        provider_requests: [], turn_attempts: turns.map((_, index) => ({ turn_id: index + 1, accepted: true })),
        turns: savedTurns, log_entries: entries,
    });
    return readTrialRow(root, 1)!;
};

test("{§swebench-friction} nineteen fence-free emissions include seven admitted programs and twelve no-operation turns", (t) => {
    const turns = Array.from({ length: 19 }, (_, index) => ({
        id: index + 1, producer: "model", program: index < 7 ? "<invoke name=\"sh\">printf 42</invoke>" : "I will inspect the project.",
    }));
    const entries = turns.flatMap(({ id }) => id <= 7 ? [
        entry({ id: id * 2, turn_id: id, origin: "_plurnk", attrs: { kind: "emission" } }),
        entry({ id: id * 2 + 1, turn_id: id, op: "sh", target: null, attrs: { stream: `sh:///${id}` } }),
    ] : [entry({ id: id * 2, turn_id: id, origin: "_plurnk", source: "rail", op: "error", target: null,
        status_rx: 422, problem: { type: noOperation } })]);
    const row = trial(t, turns, entries);
    assert.deepEqual(row.friction.turns, {
        modelTurns: 19, rawEmissions: 19, fenceFree: 19, fenceFreeAdmitted: 7, noOperation: 12,
    });
});

test("{§swebench-friction} admission outcomes do not follow fence shape, content presence, or copied programs", () => {
    const result = frictionOf({
        turn_attempts: [{ turn_id: 1 }, { turn_id: 2 }, { turn_id: 2 }, { turn_id: 3 }, { turn_id: 4 }],
        turns: [
            { id: 0, program: "initialization" }, { id: 1, program: "" },
            { id: 2, program: "```not-an-operation\n```" }, { id: 3, program: "```READ (file)```" },
            { id: 4, program: null }, { id: 5, program: "copied no-operation" },
        ],
        log_entries: [
            entry({ turn_id: 1, op: "READ" }), // Reasoning-only operation, no content emission row.
            entry({ turn_id: 1, origin: "_plurnk", op: "READ", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 1, origin: "_plurnk", ambient_event_id: 7, op: "error", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 2, origin: "_plurnk", op: "error", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 2, origin: "_plurnk", op: "error", problem: { type: noOperation }, status_rx: 422 }),
            entry({ turn_id: 3, origin: "_plurnk", attrs: { kind: "emission" } }),
            entry({ turn_id: 5, origin: "_plurnk", inherited_history: true, op: "error", problem: { type: noOperation }, status_rx: 422 }),
        ],
    });
    assert.deepEqual(result.turns, { modelTurns: 4, rawEmissions: 3, fenceFree: 1, fenceFreeAdmitted: 0, noOperation: 1 });
});

test("{§swebench-friction} failed receipts preserve provenance and channels do not multiply failed executions", (t) => {
    const failure = { status_rx: 500, problem: { type: nonzero }, target: "sh:///process#stdout" };
    const row = trial(t, [{ id: 1, program: "```READ (sh:///process)```" }], [
        entry({ ...failure, ambient_event_id: 71 }),
        entry({ ...failure, origin: "_plurnk", target: "sh:///process#stderr" }),
        entry({ ...failure, origin: "_plurnk", target: "sh:///process#stdout" }),
        entry({ ...failure, origin: "_plurnk", ambient_event_id: 71 }),
        entry({ ...failure, inherited_history: true, ambient_event_id: 71 }),
        entry({ ...failure, origin: "_plurnk", inherited_history: true, ambient_event_id: 71 }),
        entry({ ...failure, origin: "_plurnk", target: "sh:///second#stdout" }),
        entry({ status_rx: 416, problem: { type: range }, target: "sh:///third#stdout" }),
        entry({ ...failure, origin: "_plurnk", target: null }),
        entry({ status_rx: 422, op: "EDIT", problem: { type: range } }),
    ]);
    assert.deepEqual(row.friction.failures, {
        receipts: { authored: { READ: 2, EDIT: 1 }, automatic: { READ: 4 }, ambient: { READ: 1 }, inherited: { READ: 2 }, unknown: {} },
        executionStreams: [{ path: "sh:///process", receipts: 6 }, { path: "sh:///second", receipts: 1 }],
        unaddressedExecutionReceipts: 1,
    });
});

test("{§swebench-friction} absent evidence is unknown, while legacy receipts stay visible without guessed provenance", () => {
    assert.deepEqual(frictionOf(null), { turns: null, failures: null });
    assert.equal(frictionOf({ turn_attempts: [{}] }).turns, null);
    const legacy = frictionOf({
        turn_attempts: [{ turn_id: 1 }], turns: [{ id: 1, program: "hello" }],
        log_entries: [
            { origin: "model", op: "EDIT", status_rx: 422 },
            { origin: "_plurnk", op: "READ", status_rx: 500, target: "sh:///old#stdout", problem: { type: nonzero } },
            { inherited_history: false, origin: "_plurnk", op: "READ", status_rx: 500 },
            { inherited_history: true, origin: "model", op: "EDIT", status_rx: 422 },
        ],
    });
    assert.deepEqual(legacy.failures?.receipts, { authored: {}, automatic: {}, ambient: {}, inherited: { EDIT: 1 }, unknown: { EDIT: 1, READ: 2 } });
    assert.deepEqual(legacy.failures?.executionStreams, [{ path: "sh:///old", receipts: 1 }]);
    const withoutRows = frictionOf({ turn_attempts: [{ turn_id: 1 }], turns: [{ id: 1, program: "hello" }] });
    assert.deepEqual(withoutRows, { turns: { modelTurns: 1, rawEmissions: 1, fenceFree: 1, fenceFreeAdmitted: null, noOperation: null }, failures: null });
    const summary = summarizeFriction([legacy, withoutRows, frictionOf(null), legacy]);
    assert.equal(summary.turnTrials, 3);
    assert.equal(summary.failureTrials, 2);
    assert.equal(summary.turns?.noOperation, null, "missing outcomes cannot be counted as zero");
    assert.equal(summary.executionStreams, 2, "identical stream names in different trials are not one execution");
    assert.deepEqual(summary.receipts?.unknown, { EDIT: 2, READ: 4 });
    assert.equal(summarizeFriction([frictionOf(null)]).executionStreams, null);
});

test("{§swebench-friction} missing inheritance provenance cannot prove absence of authored isolation escapes", (t) => {
    const row = trial(t, [{ id: 1, program: "hello" }], [entry({ inherited_history: undefined, target: "https://example.test" })]);
    assert.equal(row.webAttempts, null);
    assert.equal(row.webReads, null);
    assert.equal(row.mcpCalls, null);
});
