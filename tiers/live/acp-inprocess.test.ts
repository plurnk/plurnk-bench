// {§acp-daemon-client} The go-live smoke: the in-process client interface, discovered by the
// daemon and mounted at /acp on its listener, drives
// a real model session through the shared live runner.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { client as createAcpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import { bindListener, Daemon, liveProvider, liveRun, liveTest as test, openMigrated, serverProposals } from "@plurnk/plurnk-service/harness";

test("live: discovery and model response traverse the in-process ACP module", async (t) => {
    serverProposals(t, "accept");

    // {§tier-census} — the session's run directory holds its database, its own host and, at the end,
    // its digest and census row, like every other live session's.
    const run = await liveRun("live-acp-inprocess");
    const db = await openMigrated(run.dbPath);
    const provider = await liveProvider();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider, nodeModulesPath: join(process.cwd(), "../node_modules"), http, hostPaths: run.hostPaths });
    const sandbox = await mkdtemp(join(tmpdir(), "acp-inproc-"));

    // The daemon discovers the module, starts it on the application port, and admits its listener.
    await daemon.start();
    const addr = http.httpAddress();

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
            const discovered = await ctx.request<{ schemaVersion: number }>("_plurnk/action", { kind: "discover", params: {} });
            assert.equal(discovered.schemaVersion, 1);
            const providers = await ctx.request(methods.agent.providers.list, {});
            assert.ok(providers.providers.length > 0, "the active provider is discoverable");
            await ctx.buildSession(sandbox).withSession(async (session) => {
                await session.prompt("Reply with the single word READY.");
                const reply = await session.readTextUntilIdle(t.signal);
                assert.match(reply, /READY/i);
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
