// {§tier-corpus} — multi-child topology probes: fan-out and dependent two-stage pipeline, verifying
// both final answer accuracy and >= 2 delegated sessions in SQLite.
import assert from "node:assert/strict";
import {
    failAfterCleanup,
    liveLoop,
    liveTest as test,
    liveWorkspace,
    readSessionTopology,
    seedDemoFixture,
} from "@plurnk/plurnk-service/harness";

const runStory = async (opts: { signal: AbortSignal; label: string; prompt: string; maxTurns?: number }) => {
    const fixture = await seedDemoFixture(opts.label);
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `topo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(
            s,
            2,
            { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) },
            { signal: opts.signal },
        );
        const { finalStatus, hitMaxTurns, turnIds, lastContent } = loop;
        const { sessions, delegatedSessions } = await readSessionTopology(s.db, s.workspaceId);
        console.error(`[topo:${opts.label}] turns=${turnIds.length} finalStatus=${finalStatus} hitMaxTurns=${hitMaxTurns} delegatedSessions=${delegatedSessions}`);
        const dump = async (): Promise<void> => {
            console.error(`sessions: ${sessions.map((r) => `${r.id}:${r.name}`).join(", ")}`);
            for (const turnId of turnIds) {
                const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`--- turn ${turnId} status=${row?.status} ---\n${(packet.assistant?.content ?? "").slice(0, 1500)}`);
            }
        };
        return { finalStatus, lastContent, delegatedSessions, dump, cleanup };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

test("topo probe: answer a multi-part task that invites fan-out", async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "fanout",
        prompt: "src/config.json has three settings: db, pool, and host. Have a separate session look up each one, then give me all three values together.",
        maxTurns: 20,
    });
    try {
        const expected = [/\bpostgres\b/i, /\b5\b/, /\bdb\.internal\b/];
        if (story.finalStatus !== 200 || story.delegatedSessions < 2 || expected.some((value) => !value.test(story.lastContent))) {
            await story.dump();
        }
        assert.equal(story.finalStatus, 200, "the multi-part task concluded");
        assert.ok(story.delegatedSessions >= 2, `expected >= 2 delegated sessions, got ${story.delegatedSessions}`);
        for (const value of expected) {
            assert.match(story.lastContent, value, `the report includes every requested setting; got: ${story.lastContent.slice(0, 250)}`);
        }
    } finally {
        await story.cleanup();
    }
});

test("topo probe: answer a dependent two-stage task that invites a pipeline", async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "pipeline",
        prompt: "First have a session count how many users are in data/users.json. Then have a second session check whether that count is more than 2. Give me the final yes-or-no answer.",
        maxTurns: 14,
    });
    try {
        if (story.finalStatus !== 200 || story.delegatedSessions < 2) await story.dump();
        assert.equal(story.finalStatus, 200, "the dependent task concluded");
        assert.ok(story.delegatedSessions >= 2, `expected >= 2 delegated sessions, got ${story.delegatedSessions}`);
        assert.match(story.lastContent, /\byes\b/i, `3 users IS more than 2 → the final answer is yes; got: ${story.lastContent.slice(0, 250)}`);
    } finally {
        await story.cleanup();
    }
});
