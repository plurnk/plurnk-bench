// Reply demos: the user is TALKING TO plurnk about plurnk, not giving it a task. These
// are the cases benchmarks never cover — a benchmark grades the workspace afterwards, these
// demos grade the reply. Showing an operation must never run it ({§tier-corpus}), and an
// answer must actually arrive.
//
// Strict by design: an advisory, a strike, an empty turn or a mutation is a failure here, even
// when the final text happens to be right.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";
import { seedDemoFixture } from "@plurnk/plurnk-service/harness";
import { failAfterCleanup } from "@plurnk/plurnk-service/harness";
import { ResourceState } from "@plurnk/plurnk-service/harness";

const MUTATING = new Set(["EDIT", "KILL", "COPY", "MOVE", "WORK", "FORK"]);

interface Answered {
    readonly finalStatus: number;
    readonly reply: string;
    readonly ops: Array<{ op: string | null; status: number }>;
    readonly notices: string[];
}

const ask = async (opts: { signal: AbortSignal; label: string; prompt: string; maxTurns?: number }): Promise<{ result: Answered; notes: string; cleanup: () => Promise<void> }> => {
    const fixture = await seedDemoFixture(opts.label);
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `demo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(s, 2, { prompt: opts.prompt, maxTurns: opts.maxTurns ?? 6 }, { signal: opts.signal });
        const rows = (await Promise.all(loop.turnIds.map((turn_id) =>
            s.db.test_log_entries_by_turn.all<{ op: string | null; origin: string; status_rx: number; tx: string }>({ turn_id }),
        ))).flat();
        const ops = rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => ({
            op, status: status_rx,
        }));
        // Every notice the packets carried: the model's own complaint surface.
        const notices: string[] = [];
        for (const turnId of loop.turnIds) {
            const row = await s.db.test_get_turn.get<{ packet: string }>({ id: turnId });
            for (const section of (JSON.parse(row?.packet ?? "{}") as { sections?: Array<{ name?: string; content?: string }> }).sections ?? []) {
                if (section.name === "notices" && typeof section.content === "string") notices.push(section.content);
            }
        }
        assert.deepEqual(await ResourceState.check(s.db), [], `[${opts.label}] the workspace stays lawful`);
        const notes = join(fixture.workspace, "notes.md");
        return { result: { finalStatus: loop.finalStatus, reply: loop.lastContent, ops, notices }, notes, cleanup };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

test("reply: plurnk explains its own operations, and shows examples without running them", { timeout: 600_000 }, async (t) => {
    const { result, notes, cleanup } = await ask({
        signal: t.signal,
        label: "self-description",
        prompt: "Please summarize Plurnk's operations for me, with a short example of each. Don't perform any of them.",
    });
    try {
        const before = await readFile(notes, "utf8");
        assert.equal(result.finalStatus, 200, "the question is answered");
        assert.ok(result.reply.length > 0, "the answer reaches the client");
        const named = ["READ", "EDIT", "FIND", "SEND", "KILL"].filter((op) => result.reply.includes(op));
        assert.ok(named.length >= 4, `the answer names plurnk's operations; named ${JSON.stringify(named)}`);
        assert.match(result.reply, /\b(?:READ|EDIT|FIND) \([^\r\n)]+\)/u, "examples reach the client, not merely a pointer to an internal note");
        const ran = result.ops.filter(({ op }) => op !== null && MUTATING.has(op));
        assert.deepEqual(ran, [], "showing an operation never runs it");
        assert.equal(await readFile(notes, "utf8"), before, "the fixture is untouched");
        assert.deepEqual(result.notices.filter((message) => /advisory|turn_no_operations|nothing ran|must start its line|shown, not run/i.test(message)), [], "the model's examples draw no parser complaint");
    } finally { await cleanup(); }
});

test("reply: asked to show a deletion without doing it, plurnk shows it and deletes nothing", { timeout: 600_000 }, async (t) => {
    const { result, notes, cleanup } = await ask({
        signal: t.signal,
        label: "show-dont-run",
        prompt: "How would you delete notes.md? Show me the exact operation you would use, but do not delete anything.",
    });
    try {
        assert.equal(result.finalStatus, 200, "the question is answered");
        assert.ok(/KILL/.test(result.reply), "the answer shows the operation it would use");
        assert.deepEqual(result.ops.filter(({ op }) => op !== null && MUTATING.has(op)), [], "nothing was deleted");
        assert.ok((await readFile(notes, "utf8")).length > 0, "notes.md is still there");
        assert.deepEqual(result.notices.filter((message) => /advisory|turn_no_operations|nothing ran|must start its line|shown, not run/i.test(message)), [], "showing the deletion draws no parser complaint");
    } finally { await cleanup(); }
});
