// {§tier-corpus} — cancellation settles an in-flight provider request cleanly whether or not
// the route streams reasoning deltas before content.
import assert from "node:assert/strict";
import { liveLoop, liveTest as test, liveWorkspace, waitForDb } from "@plurnk/plurnk-service/harness";

test("live: cancellation settles an active model request", async (t) => {
    const s = await liveWorkspace({ name: "live-cancellation-accounting" });
    const cancellation = new AbortController();
    const reason = new Error("live cancellation during open provider request");
    let loopId: number | undefined;
    let cancelling = false;
    const triggerCancel = (activeLoopId: number): void => {
        if (cancelling) return;
        cancelling = true;
        loopId = activeLoopId;
        cancellation.abort(reason);
    };
    const unsubscribe = s.daemon.subscribeToRuntimeStream((_workspaceId, method, params) => {
        if (method === "reasoning/event" && (params as { phase?: string }).phase === "content") {
            triggerCancel((params as { loopId: number }).loopId);
            return;
        }
        if (method === "runtime/telemetry") {
            const telemetry = params as { loopId?: number; notice?: { kind?: string } };
            if (telemetry.notice?.kind === "turn_awaiting_model" && typeof telemetry.loopId === "number") {
                const candidateLoopId = telemetry.loopId;
                void (async () => {
                    try {
                        await waitForDb(
                            async () => {
                                const turns = await s.db.test_list_turns_in_loop.all<{ id: number; kind: string }>({ loop_id: candidateLoopId });
                                const inference = turns.find(({ kind }) => kind === "inference");
                                if (inference === undefined) return [];
                                const reqs = await s.db.test_provider_requests.all<{ state: string }>({ turn_id: inference.id });
                                return reqs.filter(({ state }) => state === "open");
                            },
                            (openReqs) => openReqs.length >= 1 || cancelling,
                            { timeoutMs: 5_000, intervalMs: 5 },
                        );
                        triggerCancel(candidateLoopId);
                    } catch {
                        // Settled or aborted before poll completed.
                    }
                })();
            }
        }
    });
    try {
        await assert.rejects(
            liveLoop(
                s,
                2,
                {
                    prompt: "Write a thorough 600-word comparison of breadth-first search, depth-first search, Dijkstra's algorithm, and A* search, including time and memory complexity for each.",
                    maxTurns: 1,
                },
                { signal: AbortSignal.any([t.signal, cancellation.signal]) },
            ),
            (error) => error === reason,
        );
        assert.ok(loopId !== undefined, "in-flight provider request was observed before cancellation");
        const turns = await waitForDb(
            () => s.db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; completed_at: string | null }>({ loop_id: loopId! }),
            (rows) => rows.some(({ kind }) => kind === "inference") && rows.every(({ completed_at }) => completed_at !== null),
        );
        const inference = turns.filter(({ kind }) => kind === "inference");
        assert.equal(inference.length, 1);
        assert.equal(inference[0].status, 499);
        const requests = await s.db.test_provider_requests.all<{ state: string; outcome: string }>({ turn_id: inference[0].id });
        assert.equal(requests.length, 1, "cancellation does not start a replacement request");
        assert.equal(requests[0].state, "settled");
        assert.equal(requests[0].outcome, "error");
    } finally {
        unsubscribe();
        await s.cleanup();
    }
});
