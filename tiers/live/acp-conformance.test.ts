// {§acp-first-party-client-conformance} Optional real-model counterpart of the
// deterministic official-client gate.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { client as createAcpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import { bindListener, Daemon, liveProvider, liveRun, liveTest as test, openMigrated, serverProposals } from "@plurnk/plurnk-service/harness";

test("live: the ACP client accepts the complete model response stream", async (t) => {
    serverProposals(t, "accept");

    // {§test-artifact-retention} — the session's run directory holds its database, its own host and, at the end,
    // its digest and census row, like every other live session's.
    const run = await liveRun("live-acp-conformance");
    const db = await openMigrated(run.dbPath);
    const provider = await liveProvider();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(process.cwd(), "../node_modules"), http, hostPaths: run.hostPaths });
    await daemon.start();
    const addr = http.httpAddress();
    const sandbox = await mkdtemp(join(tmpdir(), "acp-conf-"));

    try {
        // {§acp-http-authorization} — an access token the daemon's own authority issued; under the
        // gate profile's PLURNK_AUTH=0 the listener ignores it and admits anonymously.
        const token = daemon.credentials.issue({ kind: "access", subject: "operator", clientId: "operator", scopes: ["acp"], family: "live", ttlMs: 600_000 }).token;
        const wsCtor: WebSocketConstructor = Reflect.get({ v: WebSocket }, "v");
        const stream = createWebSocketStream(`ws://${addr.host}:${addr.port}/acp`, {
            WebSocket: wsCtor,
            ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        });
        const app = createAcpClient().onConnect((conn) => {
            void conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "test-client", version: "1.0.0" },
            });
        });
        await app.connectWith(stream, async (ctx) => {
            await ctx.buildSession(sandbox).withSession(async (session) => {
                await session.prompt("Reply with the single word PONG.");
                const reply = await session.readTextUntilIdle(t.signal);
                assert.match(reply, /PONG/i);
            });
        });
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        run.finish();
        await rm(sandbox, { recursive: true, force: true });
    }
});
