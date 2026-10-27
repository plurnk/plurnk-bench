// Delegation ping/pong with a real model ({§tier-corpus}, {§tier-corpus}): the parent names
// a session, gives it a task, waits for its answer, then addresses the same session again by name, which is a
// message to it rather than a second session, and waits again. Read friction first: a refused or failed model
// operation in either session is a failure here even when the final reply is right, and so is a second
// session where one was named.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";
import { seedDemoFixture } from "@plurnk/plurnk-service/harness";
import { failAfterCleanup } from "@plurnk/plurnk-service/harness";
import { rpcCall } from "@plurnk/plurnk-service/harness";
import { ResourceState } from "@plurnk/plurnk-service/harness";

interface LogRow { op: string | null; origin: string; status_rx: number; rx: string; tx: string }

test("delegation: ping/pong with one named session — spawn, answer, message by name, answer again", { timeout: 600_000 }, async (t) => {
    const fixture = await seedDemoFixture("ping-pong");
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `demo-ping-pong-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(s, 2, {
            prompt: "Play ping pong with one helper. Create a session named pong whose only job is to answer each 'ping N' with 'pong N'. "
                + "Send it 'ping 1' and wait for its answer. Then send 'ping 2' to the same session, by its name, and wait for that answer too. "
                + "Finally reply to me with both of pong's answers, verbatim.",
            maxTurns: 14,
        }, { signal: t.signal });
        const sessions = ((await rpcCall(s.ws, 3, "workspace.sessions", {})).result as { sessions: Array<{ id: number; name: string; origin: string }> }).sessions
            .filter((session) => session.origin === "model");
        const pong = sessions.filter((session) => session.name === "pong");
        const logs = new Map<string, LogRow[]>();
        for (const session of sessions) {
            logs.set(session.name, await s.db.engine_render_log.all<LogRow>({ session_id: session.id }));
        }
        // Friction first: every model operation of every session succeeded.
        const refused = [...logs.entries()].flatMap(([name, rows]) => rows
            .filter((row) => row.origin === "model" && row.status_rx >= 400)
            .map((row) => `${name}: ${row.op} ${row.status_rx} ${(JSON.parse(row.rx) as { problem?: { type?: string } }).problem?.type?.split("/").slice(-2).join("/") ?? ""}`));
        assert.deepEqual(refused, [], "no model operation was refused or failed in either session");
        assert.deepEqual(await ResourceState.check(s.db), [], "the workspace stays lawful");

        assert.equal(loop.finalStatus, 200, "the parent concluded");
        assert.equal(pong.length, 1, `one session named pong; sessions ${JSON.stringify(sessions.map((session) => session.name))}`);
        assert.equal(sessions.length, 2, "the parent and pong, nothing else");
        const parent = sessions.find((session) => session.id === loop.modelSessionId)!;
        const targetOf = (row: LogRow): string => { try { return (JSON.parse(row.tx) as { target?: { raw?: string } }).target?.raw ?? ""; } catch { return ""; } };
        const toPong = (logs.get(parent.name) ?? []).filter((row) => row.origin === "model" && (row.op === "WORK" || row.op === "SEND") && targetOf(row).includes("session://pong"));
        assert.ok(toPong.length >= 2, `the parent addressed pong at least twice; saw ${toPong.length}`);
        assert.ok(toPong.some((row) => row.op === "SEND" || row.rx.includes("\"delivered\":\"message\"")), "the second address was a message to the live session, not a second spawn");
        const answered = await s.db.test_message_completions_from.all<{ status: number }>({ workspace_id: s.workspaceId, source: `session://${parent.name}` });
        assert.ok(answered.filter((row) => row.status === 200).length >= 1, "pong completed at least the message it was sent by name");
        assert.match(loop.lastContent, /pong\s*1/iu, "the first answer reaches the client");
        assert.match(loop.lastContent, /pong\s*2/iu, "and the second");
        await cleanup();
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
});
