// {§tier-corpus} — interactive ACPv2 `elicitation/create` across both modes in one session:
// `mode: "url"` (+ `elicitation/complete` for MCP OAuth sign-in) and `mode: "form"` (`plurnk.question`).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type CreateElicitationRequest,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { isRecord } from "@plurnk/plurnk-contracts";
import { WebSocket } from "ws";
import {
    bindListener,
    Daemon,
    initializeDemoRepository,
    liveProvider,
    liveRun,
    liveTest as test,
    openMigrated,
    serveOAuthMcp,
    waitFor,
} from "@plurnk/plurnk-service/harness";

const WsConstructor = WebSocket as unknown as WebSocketConstructor;

const buildFormAnswer = (schema: unknown): Record<string, unknown> => {
    if (!isRecord(schema) || !isRecord(schema.properties)) return { environment: "staging" };
    const answer: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties)) {
        if (!isRecord(prop)) {
            answer[key] = "staging";
            continue;
        }
        if (Array.isArray(prop.enum) && prop.enum.length > 0) {
            const stagingOpt = prop.enum.find((v) => typeof v === "string" && /staging/i.test(v));
            answer[key] = stagingOpt ?? prop.enum[0];
        } else if (prop.type === "boolean") {
            answer[key] = true;
        } else if (prop.type === "number" || prop.type === "integer") {
            answer[key] = 1;
        } else {
            answer[key] = "staging";
        }
    }
    return Object.keys(answer).length > 0 ? answer : { environment: "staging" };
};

test("demo: interactive ACPv2 handles URL-mode MCP OAuth elicitation and form-mode question elicitation end-to-end", async (t) => {
    // `.env.defaults` sets PLURNK_EXECS_PLURNK_QUESTION=0 for unattended benchmarks; enable interactive question here.
    const savedQuestion = process.env.PLURNK_EXECS_PLURNK_QUESTION;
    const savedMcp = process.env.PLURNK_MCP_ENABLED;
    delete process.env.PLURNK_EXECS_PLURNK_QUESTION;
    process.env.PLURNK_MCP_ENABLED = "1";
    t.after(() => {
        if (savedQuestion === undefined) delete process.env.PLURNK_EXECS_PLURNK_QUESTION;
        else process.env.PLURNK_EXECS_PLURNK_QUESTION = savedQuestion;
        if (savedMcp === undefined) delete process.env.PLURNK_MCP_ENABLED;
        else process.env.PLURNK_MCP_ENABLED = savedMcp;
    });

    const marker = `DEPLOY_VERIFIED_${crypto.randomUUID().slice(0, 8)}`;
    const code = crypto.randomUUID();
    let toolCalls = 0;
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "release-gate", version: "1.0.0" });
        server.registerTool(
            "release_ticket",
            { description: "Return the verified release ticket for the selected environment." },
            async () => {
                toolCalls++;
                return { content: [{ type: "text", text: `staging=${marker}` }] };
            },
        );
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const { served } = await serveOAuthMcp(t, handler, { code });
    const redirectUrl = new URL("/callback", served.url).href;

    const sandbox = await mkdtemp(join(tmpdir(), "plurnk-demo-elicit-"));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    initializeDemoRepository(sandbox, "elicitation demo fixture");

    const run = await liveRun("demo-question-and-oauth-elicitation");
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

        const elicitations: CreateElicitationRequest[] = [];
        const completedElicitations: string[] = [];
        const updates: SessionUpdate[] = [];

        const app = createRawAcpClient()
            .onConnect((conn) => {
                void conn.agent.request(methods.agent.initialize, {
                    protocolVersion: PROTOCOL_VERSION,
                    info: { name: "tier-elicitation-client", version: "1.0.0" },
                    capabilities: {
                        elicitation: { form: {}, url: {} },
                        session: { commands: { skill: {} }, promptSuggestions: {} },
                    },
                });
            })
            .onNotification(methods.client.session.update, ({ params }) => {
                updates.push(params.update);
            })
            .onNotification(methods.client.elicitation.complete, ({ params }) => {
                completedElicitations.push(params.elicitationId);
            })
            .onRequest(methods.client.elicitation.create, async ({ params }) => {
                elicitations.push(params);
                if ("requestedSchema" in params) {
                    return {
                        action: "accept",
                        content: buildFormAnswer(params.requestedSchema),
                    };
                }
                return { action: "accept" };
            });

        const wsStream = createWebSocketStream(`ws://127.0.0.1:${port}/acp`, {
            WebSocket: WsConstructor,
        });

        await app.connectWith(wsStream, async (ctx) => {
            await ctx.initialized;
            const created = await ctx.request(methods.agent.session.new, { cwd: sandbox });
            const acpSessionId = created.sessionId;
            const workspaceId = Number(acpSessionId.split("#")[0]);

            // Register the OAuth-protected MCP server on the workspace (`authorization-required`),
            // then drive `/mcp oauth gate` -> `elicitation/create` (`mode: "url"`) -> callback -> `elicitation/complete`!
            await daemon.invokeModuleAction(
                "workspace.mcp.add",
                {
                    alias: "gate",
                    type: "streamable-http",
                    url: served.url,
                    authorization: { type: "oauth", redirectUrl },
                },
                { scope: "workspace", workspaceId },
            );

            await ctx.request(methods.agent.session.prompt, {
                sessionId: acpSessionId,
                prompt: [{ type: "text", text: "/mcp oauth gate" }],
            });
            await waitFor(
                () => elicitations.filter((e) => e.mode === "url"),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );
            const urlElicit = elicitations.find(
                (e): e is Extract<CreateElicitationRequest, { mode: "url" }> => e.mode === "url",
            )!;
            assert.equal(urlElicit.elicitationId, `mcp-oauth:${workspaceId}:gate`);

            const authUrl = new URL(urlElicit.url);
            const cb = new URL(redirectUrl);
            cb.searchParams.set("state", authUrl.searchParams.get("state")!);
            cb.searchParams.set("iss", authUrl.origin);
            cb.searchParams.set("code", code);

            await ctx.request(methods.agent.session.prompt, {
                sessionId: acpSessionId,
                prompt: [{ type: "text", text: `/mcp oauth gate ${cb.href}` }],
            });
            await waitFor(
                () => completedElicitations.filter((id) => id === `mcp-oauth:${workspaceId}:gate`),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );
            await waitFor(
                () => updates.filter((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
                (items) => items.length >= 2,
                { timeoutMs: 10_000 },
            );
            updates.length = 0;

            // Now prompt the model: ask the user via `question` (`mode: "form"`), then invoke `gate.release_ticket`.
            await ctx.request(methods.agent.session.prompt, {
                sessionId: acpSessionId,
                prompt: [{
                    type: "text",
                    text: "Use the `question` tool to ask me which deployment environment (`staging` or `production`) to check, then call the `gate` MCP server's `release_ticket` tool and report both my chosen environment and the exact verification ticket.",
                }],
            });
            await waitFor(
                () => updates,
                (items) => {
                    const runningIdx = items.findIndex((u) => u.sessionUpdate === "state_update" && u.state === "running");
                    return runningIdx >= 0 && items.slice(runningIdx + 1).some((u) => u.sessionUpdate === "state_update" && u.state === "idle");
                },
                { timeoutMs: 120_000 },
            );
        });

        assert.ok(elicitations.some((e) => e.mode === "url"), "URL-mode elicitation fired");
        assert.ok(elicitations.some((e) => "requestedSchema" in e), "form-mode question elicitation fired");
        assert.ok(toolCalls >= 1, "OAuth-protected MCP tool was invoked after authorization");

        const replyText = updates
            .filter((u): u is Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }> => u.sessionUpdate === "agent_message_chunk")
            .map((u) => ("text" in u.content && typeof u.content.text === "string" ? u.content.text : ""))
            .join("");
        assert.match(replyText, /staging/i, "reply reflects the form elicitation choice");
        assert.ok(replyText.includes(marker), `reply carries the OAuth MCP ticket (${marker})`);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        run.finish();
    }
});
