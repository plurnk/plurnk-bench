// {§tier-corpus} — inbound Streamable HTTP `/mcp/<workspace>/<session>` server surface:
// `tools/list`, `resources/list`, `tools/call`, `resources/subscribe` (`notifications/resources/updated`
// when a real model loop mutates the subscribed resource), and `resources/read`.
import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
    bindListener,
    Daemon,
    liveProvider,
    liveRun,
    liveTest as test,
    openMigrated,
    waitFor,
} from "@plurnk/plurnk-service/harness";

test("live: inbound /mcp/<workspace>/<session> serves tools/call, resources/read, and live resource subscriptions across a model loop", async (t) => {
    const run = await liveRun("live-mcp-inbound");
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
        const wsName = `inbound-ws-${crypto.randomUUID().slice(0, 8)}`;
        const sessionName = "agent";

        const mcpClient = new Client({ name: "tier-mcp-inbound", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${port}/mcp/${wsName}/${sessionName}`),
        );
        await mcpClient.connect(transport);
        t.after(() => mcpClient.close());

        const { tools } = await mcpClient.listTools();
        const toolNames = new Set(tools.map((tool) => tool.name));
        for (const expected of ["read", "edit", "note", "sh"]) {
            assert.ok(toolNames.has(expected), `inbound /mcp advertises ${expected}`);
        }

        const { resources } = await mcpClient.listResources();
        const resourceUris = new Set(resources.map((r) => r.uri));
        assert.ok(resourceUris.has("mcp:///plurnk.md"));
        assert.ok(resourceUris.has("plurnk:///status.json"));

        // Seed `workspace:///state.md` through inbound MCP `tools/call`!
        const seeded = await mcpClient.callTool({
            name: "edit",
            arguments: { path: "workspace:///state.md", text: "STAGE=ALPHA\n" },
        });
        assert.notEqual(seeded.isError, true, `edit tool succeeded: ${JSON.stringify(seeded)}`);

        // Subscribe to `workspace:///state.md` and wait briefly for GET SSE stream setup.
        const updatedUris: string[] = [];
        mcpClient.setNotificationHandler("notifications/resources/updated", (notification) => {
            updatedUris.push(notification.params.uri);
        });
        await mcpClient.subscribeResource({ uri: "workspace:///state.md" });
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        // Resolve workspace & session created by `/mcp/<ws>/<session>` and drive one real model loop.
        const workspaces = await daemon.listWorkspaces();
        const ws = workspaces.find((entry) => entry.name === wsName);
        assert.ok(ws, "inbound /mcp auto-created the named workspace");
        const sessions = await daemon.listSessions(ws.id);
        const session = sessions.find((entry) => entry.name === sessionName);
        assert.ok(session, "inbound /mcp auto-created the named session");

        const terminated = Promise.withResolvers<{ status: number }>();
        const off = daemon.subscribeToEvents((wsId, method, params) => {
            if (wsId === ws.id && method === "loop/terminated" && (params as { sessionId?: number }).sessionId === session.id) {
                terminated.resolve((params as { result: { status: number } }).result);
            }
        });
        t.after(off);

        await daemon.runLoop({
            workspaceId: ws.id,
            sessionId: session.id,
            prompt: "In `workspace:///state.md`, replace `STAGE=ALPHA` with `STAGE=OMEGA` and confirm.",
            maxTurns: 6,
        });
        const finalResult = await terminated.promise;
        assert.equal(finalResult.status, 200);

        await waitFor(
            () => updatedUris.filter((uri) => uri === "workspace:///state.md"),
            (items) => items.length >= 1,
            { timeoutMs: 10_000 },
        );

        const readBack = await mcpClient.readResource({ uri: "workspace:///state.md" });
        const text = readBack.contents
            .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
            .join("");
        assert.match(text, /STAGE=OMEGA/);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        run.finish();
    }
});
