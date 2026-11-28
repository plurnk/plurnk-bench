// {§tier-corpus} — `GET /notifications` Watch SSE stream, unified envelope schema validation,
// session-scoped filtering, and `Last-Event-ID` cursor replay across a real model loop while disconnected.
import assert from "node:assert/strict";
import {
    APPLICATION_RUNTIME_STREAM_EVENTS,
    Validator,
    type DaemonNotificationStreamEnvelope,
} from "@plurnk/plurnk-contracts";
import {
    bindListener,
    Daemon,
    liveProvider,
    liveRun,
    liveTest as test,
    openMigrated,
    waitFor,
} from "@plurnk/plurnk-service/harness";

interface ParsedFrame {
    readonly id: string | null;
    readonly event: string;
    readonly envelope: DaemonNotificationStreamEnvelope;
}

const connectSse = async (url: string, headers: Readonly<Record<string, string>> = {}) => {
    const controller = new AbortController();
    const res = await fetch(url, {
        headers: { accept: "text/event-stream", ...headers },
        signal: controller.signal,
    });
    assert.equal(res.status, 200);
    const frames: ParsedFrame[] = [];
    const opened = Promise.withResolvers<void>();
    const done = (async () => {
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            for await (const chunk of res.body!) {
                buffer += decoder.decode(chunk, { stream: true });
                const parts = buffer.split("\n\n");
                buffer = parts.pop() ?? "";
                for (const raw of parts) {
                    if (raw.startsWith(":")) {
                        opened.resolve();
                        continue;
                    }
                    let id: string | null = null;
                    let event = "message";
                    let dataText: string | null = null;
                    for (const line of raw.split("\n")) {
                        if (line.startsWith("id: ")) id = line.slice(4);
                        else if (line.startsWith("event: ")) event = line.slice(7);
                        else if (line.startsWith("data: ")) dataText = line.slice(6);
                    }
                    if (dataText === null) continue;
                    const parsed: unknown = JSON.parse(dataText);
                    const envelope = Validator.assertDaemonNotification(
                        parsed,
                    ) as DaemonNotificationStreamEnvelope;
                    assert.equal(envelope.event, event);
                    frames.push({ id, event, envelope });
                    opened.resolve();
                }
            }
        } catch (err) {
            if (!controller.signal.aborted) throw err;
        }
    })();
    await opened.promise;
    return {
        frames,
        close: async () => {
            controller.abort();
            await done;
        },
    };
};

test("live: GET /notifications hydrates Watch snapshots and replays missed model-loop transitions via Last-Event-ID", async (t) => {
    const run = await liveRun("live-notifications-sse");
    const db = await openMigrated(run.dbPath);
    const http = await bindListener();
    const provider = await liveProvider();
    const daemon = new Daemon({
        db,
        dbPath: run.dbPath,
        provider,
        http,
        hostPaths: run.hostPaths,
    });

    try {
        await daemon.start();
        const { port } = http.httpAddress();
        const baseUrl = `http://127.0.0.1:${port}/notifications`;

        const firstStream = await connectSse(baseUrl);
        t.after(() => firstStream.close());

        await waitFor(
            () => firstStream.frames.filter((f) => f.event === "notifications/snapshot"),
            (items) => items.length === 1,
            { timeoutMs: 5_000 },
        );

        const { workspaceId } = await daemon.createWorkspace({ name: "sse-live-ws" });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "worker" });
        await waitFor(
            () => firstStream.frames.filter((f) => f.event === "session/created"),
            (items) => items.length === 1,
            { timeoutMs: 5_000 },
        );
        const cursorBeforeLoop = firstStream.frames.find((f) => f.event === "session/created")!.id!;
        assert.match(cursorBeforeLoop, new RegExp(`^${daemon.notificationEpoch}:\\d+$`, "u"));

        // Disconnect SSE client BEFORE running the real model loop!
        await firstStream.close();

        const runtimeEvents = new Set<string>();
        const offRuntime = daemon.subscribeToRuntimeStream((_wsId, method) => {
            runtimeEvents.add(method);
        });
        t.after(offRuntime);

        const terminated = Promise.withResolvers<{ status: number }>();
        const off = daemon.subscribeToEvents((wsId, method, params) => {
            if (wsId === workspaceId && method === "loop/terminated" && (params as { sessionId?: number }).sessionId === sessionId) {
                terminated.resolve((params as { result: { status: number } }).result);
            }
        });
        t.after(off);

        await daemon.runLoop({
            workspaceId,
            sessionId,
            prompt: "Reply with the single word `ACKNOWLEDGED`.",
            maxTurns: 4,
        });
        assert.equal((await terminated.promise).status, 200);

        // Reconnect scoped to `/notifications/<workspaceId>/worker` with `Last-Event-ID`!
        const replayStream = await connectSse(`${baseUrl}/${workspaceId}/worker`, {
            "last-event-id": cursorBeforeLoop,
        });
        t.after(() => replayStream.close());

        await waitFor(
            () => replayStream.frames.filter((f) => f.event === "loop/terminated"),
            (items) => items.length === 1,
            { timeoutMs: 5_000 },
        );

        const replayedEvents = new Set(replayStream.frames.map((f) => f.event));
        assert.equal(replayedEvents.has("notifications/snapshot"), false, "in-window cursor replays without snapshot");
        assert.equal(replayedEvents.has("notifications/resync"), false, "in-window cursor replays without resync");
        assert.equal(replayedEvents.has("loop/started"), true, "replayed loop/started");
        assert.equal(replayedEvents.has("session/replied"), true, "replayed compact session/replied");
        assert.equal(replayedEvents.has("loop/terminated"), true, "replayed loop/terminated");
        assert.equal(runtimeEvents.has("log/entry"), true, "log/entry stays on subscribeToRuntimeStream");
        for (const runtimeEvent of APPLICATION_RUNTIME_STREAM_EVENTS) {
            assert.equal(replayedEvents.has(runtimeEvent), false, `${runtimeEvent} never leaks onto /notifications`);
        }
        await replayStream.close();
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        run.finish();
    }
});
