import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { liveLoop, liveWorkspace } from "@plurnk/plurnk-service/harness";
import { waitForDb } from "@plurnk/plurnk-service/harness";

test("live: cancellation settles an active model request", { requires: ["reasoning"] }, async (t) => {
    const s = await liveWorkspace({ name: "live-cancellation-accounting" });
    const cancellation = new AbortController();
    const reason = new Error("live cancellation after first reasoning delta");
    let loopId: number | undefined;
    const unsubscribe = s.daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method !== "reasoning/event" || (params as { phase?: string }).phase !== "content") return;
        loopId = (params as { loopId: number }).loopId;
        cancellation.abort(reason);
    });
    try {
        await assert.rejects(liveLoop(s, 2, {
            prompt: "Compare breadth-first and depth-first search, including their memory costs.", maxTurns: 1,
        }, { signal: AbortSignal.any([t.signal, cancellation.signal]) }), (error) => error === reason);
        assert.ok(loopId !== undefined, "reasoning was received before cancellation");
        // {§provider-cancellation-evidence}: cancellation may precede reported usage, never the request identity.
        const turns = await waitForDb(
            () => s.db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; completed_at: string | null }>({ loop_id: loopId }),
            (rows) => rows.some(({ kind }) => kind === "inference") && rows.every(({ completed_at }) => completed_at !== null),
        );
        const inference = turns.filter(({ kind }) => kind === "inference");
        assert.equal(inference.length, 1);
        assert.equal(inference[0].status, 499);
        const requests = await s.db.test_provider_requests.all<{ state: string; outcome: string }>({ turn_id: inference[0].id });
        assert.equal(requests.length, 1, "cancellation does not start a replacement request");
        assert.equal(requests[0].state, "settled");
        assert.equal(requests[0].outcome, "error");
        console.log(JSON.stringify({ runDir: s.runDir, requests }));
    } finally {
        unsubscribe();
        await s.cleanup();
    }
});
