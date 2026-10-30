// {§tier-corpus}
import assert from "node:assert/strict";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { isRecord, type FunctionalityListResult, type McpOAuthBeginResult, type McpOAuthCompletionResult } from "@plurnk/plurnk-contracts";
import { serveMcpHttp } from "@plurnk/plurnk-service/harness";
import { serveOAuthMcp } from "@plurnk/plurnk-service/harness";
import { liveLoop, liveWorkspace } from "@plurnk/plurnk-service/harness";
import { liveTest as test } from "@plurnk/plurnk-service/harness";

for (const oauth of [false, true]) {
    test(`demo: the model sets up an MCP from its URL${oauth ? ", hands sign-in to the user," : ""} and uses its discovered tool`, async (t) => {
        const marker = `VERIFIED_${crypto.randomUUID()}`;
        const code = crypto.randomUUID();
        let calls = 0;
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: "verification-service", version: "1.0.0" });
            server.registerTool("verification_code", { description: "Retrieve this service's current verification code." }, async () => {
                calls++;
                return { content: [{ type: "text", text: marker }] };
            });
            return server;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
        const served = oauth ? (await serveOAuthMcp(t, handler, { code })).served : await serveMcpHttp(t, handler);
        const key = "PLURNK_MCP_ENABLED";
        const saved = process.env[key];
        process.env[key] = "1";
        t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
        const s = await liveWorkspace({ name: `demo-mcp-setup${oauth ? "-oauth" : ""}-${crypto.randomUUID()}` });
        try {
            let oauthFlow: Promise<void> | undefined;
            const unsubscribe = oauth
                ? s.daemon.subscribeToEvents((eventWorkspaceId, method, params) => {
                    if (eventWorkspaceId !== s.workspaceId || method !== "notice/event" || oauthFlow !== undefined) return;
                    const notice = (params as { notice?: { kind?: string; message?: string } }).notice;
                    if (notice?.kind !== "authorization_required") return;
                    oauthFlow = (async () => {
                        assert.equal(calls, 0, "the tool cannot be used before sign-in");
                        const listed = await s.invokeWorkspaceAction("workspace.mcp.list", {}) as FunctionalityListResult;
                        const installed = listed.definitions.find(({ definition }) => isRecord(definition) && definition.url === served.url);
                        assert.equal(installed?.state, "authorization-required");
                        assert.ok(notice.message?.includes(`/mcp oauth ${installed.alias}`), "the user receives an actionable client sign-in notice");
                        // Simulate the user's client continuation while plurnk (mcp) holds; the built-client test owns browser/callback reception.
                        const redirect = new URL("/callback", served.url);
                        const begun = await s.invokeWorkspaceAction("workspace.mcp.oauth.begin", { alias: installed.alias, redirectUrl: redirect.href }) as McpOAuthBeginResult;
                        assert.ok("authorization" in begun && begun.authorization?.url);
                        const authorization = new URL(begun.authorization.url);
                        redirect.searchParams.set("state", authorization.searchParams.get("state")!);
                        redirect.searchParams.set("iss", authorization.origin);
                        redirect.searchParams.set("code", code);
                        const completed = await s.invokeWorkspaceAction("workspace.mcp.oauth.complete", { alias: installed.alias, callbackUrl: redirect.href }) as McpOAuthCompletionResult;
                        assert.deepEqual(completed, { status: 202, alias: installed.alias });
                    })();
                })
                : () => undefined;
            t.after(unsubscribe);
            const result = await liveLoop(s, 2, {
                prompt: `Can you add the verification-service MCP at ${served.url} and look up its verification code?`,
                maxTurns: 12,
            }, { signal: t.signal });
            if (oauth) {
                assert.ok(oauthFlow !== undefined, "the model's plurnk (mcp) triggered the authorization-required notice");
                await oauthFlow;
            }
            assert.equal(result.finalStatus, 200, "setup and use conclude cleanly");
            assert.ok(calls > 0, "the model actually invokes the newly installed remote tool");
            assert.ok(result.lastContent.includes(marker), "the answer contains evidence available only from the tool");
            const listed = await s.invokeWorkspaceAction("workspace.mcp.list", {}) as FunctionalityListResult;
            const installed = listed.definitions.find(({ definition }) => isRecord(definition) && definition.url === served.url);
            assert.equal(installed?.state, "active");
            const log = await s.daemon.readLog({ workspaceId: s.workspaceId, sessionId: result.modelSessionId, limit: Number.MAX_SAFE_INTEGER });
            assert.ok(log.some((row) => row.op === "READ" && row.scheme === installed?.alias && row.status_rx === 200 && JSON.stringify(row.rx).includes(marker)),
                "the model observes the tool result through the ordinary stream/log path");
        } finally { await s.cleanup(); }
    });
}
