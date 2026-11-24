// {§tier-corpus} — end-to-end ACPv2 lifecycle under external OIDC resource-server auth
// (`PLURNK_AUTH_ISSUER`): RFC 9728 protected-resource metadata, ES256 JWKS bearer verification,
// `createHttpStream` + `createWebSocketStream`, `session/request_permission` host-effect gate,
// and `session/resume` history replay without extra model inference.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    client as createRawAcpClient,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import {
    bindListener,
    Daemon,
    initializeDemoRepository,
    liveProvider,
    liveRun,
    liveTest as test,
    openMigrated,
    serverProposals,
    waitFor,
} from "@plurnk/plurnk-service/harness";

const WsConstructor = WebSocket as unknown as WebSocketConstructor;

const base64url = (input: string | Buffer): string =>
    Buffer.from(input).toString("base64url");

const startMockOidcProvider = async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const publicJwk = {
        ...publicKey.export({ format: "jwk" }),
        kid: "tier-es256-1",
        alg: "ES256",
        use: "sig",
    };
    let origin = "";
    const prefix = "/realms/plurnk";
    const server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        const issuer = `${origin}${prefix}`;
        const jwksUri = `${issuer}/jwks.json`;
        if (pathname === `${prefix}/.well-known/openid-configuration`) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ issuer, jwks_uri: jwksUri }));
            return;
        }
        if (pathname === `${prefix}/jwks.json`) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ keys: [publicJwk] }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
    const issuer = `${origin}${prefix}`;
    const signJwt = (claims: Record<string, unknown>): string => {
        const nowSec = Math.floor(Date.now() / 1000);
        const header = base64url(JSON.stringify({ alg: "ES256", kid: "tier-es256-1", typ: "JWT" }));
        const payload = base64url(JSON.stringify({
            iss: issuer,
            iat: nowSec,
            exp: nowSec + 300,
            ...claims,
        }));
        const signingInput = `${header}.${payload}`;
        const signature = cryptoSign("sha256", Buffer.from(signingInput), {
            key: privateKey,
            dsaEncoding: "ieee-p1363",
        });
        return `${signingInput}.${base64url(signature)}`;
    };
    return {
        issuer,
        signJwt,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
};

const makeClientApp = () =>
    createRawAcpClient().onConnect((conn) => {
        void conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "tier-acp-v2-lifecycle", version: "1.0.0" },
            capabilities: {
                session: {
                    commands: { skill: {} },
                    promptSuggestions: {},
                },
            },
        });
    });

test("live: ACPv2 external OIDC resource-server auth, HTTP/WS streams, session/request_permission, and session/resume replay", async (t) => {
    const idp = await startMockOidcProvider();
    t.after(() => idp.close());

    const savedEnv = {
        PLURNK_AUTH_ISSUER: process.env.PLURNK_AUTH_ISSUER,
        PLURNK_AUTH_CLIENT_ID: process.env.PLURNK_AUTH_CLIENT_ID,
        PLURNK_AUTH_AUDIENCE: process.env.PLURNK_AUTH_AUDIENCE,
        PLURNK_AUTH_USERS: process.env.PLURNK_AUTH_USERS,
        PLURNK_SERVICE_EFFECT_HOST: process.env.PLURNK_SERVICE_EFFECT_HOST,
    };
    const clientId = "plurnk-tier-client";
    process.env.PLURNK_AUTH_ISSUER = idp.issuer;
    process.env.PLURNK_AUTH_CLIENT_ID = clientId;
    process.env.PLURNK_AUTH_AUDIENCE = clientId;
    process.env.PLURNK_AUTH_USERS = "operator";
    process.env.PLURNK_SERVICE_EFFECT_HOST = "review";
    serverProposals(t, "review");
    t.after(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    const sandbox = await mkdtemp(join(tmpdir(), "plurnk-live-acp-v2-"));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    initializeDemoRepository(sandbox, "acp v2 lifecycle fixture");

    const run = await liveRun("live-acp-v2-lifecycle");
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
        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. Unauthenticated `/acp` is refused 401 with Bearer challenge; RFC 9728 metadata is public.
        const unauth = await fetch(`${baseUrl}/acp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
        });
        assert.equal(unauth.status, 401);
        assert.match(unauth.headers.get("www-authenticate") ?? "", /^Bearer\b/i);

        const metaRes = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
        assert.equal(metaRes.status, 200);
        const meta = (await metaRes.json()) as {
            resource: string;
            authorization_servers: string[];
            client_id?: string;
        };
        assert.equal(meta.resource, baseUrl);
        assert.ok(meta.authorization_servers.includes(idp.issuer));
        assert.equal(meta.client_id, clientId);

        // 2. Signed ES256 OIDC bearer JWT issued by the configured authorization server.
        const accessToken = idp.signJwt({ sub: "operator", aud: clientId, scope: "openid profile email" });

        // 3. Streamable HTTP transport (`createHttpStream`): initialize, list providers, create session.
        let acpSessionId = "";
        const httpStream = createHttpStream(`${baseUrl}/acp`, {
            headers: { authorization: `Bearer ${accessToken}` },
        });
        await makeClientApp().connectWith(httpStream, async (ctx) => {
            await ctx.initialized;
            const providers = await ctx.request(methods.agent.providers.list, {});
            assert.ok(Array.isArray(providers.providers) && providers.providers.length > 0);
            const created = await ctx.request(methods.agent.session.new, { cwd: sandbox });
            acpSessionId = created.sessionId;
            assert.match(acpSessionId, /^\d+#/u);
        });

        // 4. WebSocket stream (`createWebSocketStream`): resume session, handle `session/request_permission`
        // for a host-effect shell/file operation, and collect streamed agent reply.
        const permissions: RequestPermissionRequest[] = [];
        const liveUpdates: SessionUpdate[] = [];
        const wsStream = createWebSocketStream(`ws://127.0.0.1:${port}/acp`, {
            WebSocket: WsConstructor,
            headers: { authorization: `Bearer ${accessToken}` },
        });
        const wsApp = makeClientApp()
            .onNotification(methods.client.session.update, ({ params }) => {
                liveUpdates.push(params.update);
            })
            .onRequest(methods.client.session.requestPermission, async ({ params }) => {
                permissions.push(params);
                const allow = params.options.find((opt) => opt.kind === "allow_once" || opt.kind === "allow_always") ?? params.options[0]!;
                return { outcome: { outcome: "selected", optionId: allow.optionId } };
            });

        const stampValue = `ACP_OK_${crypto.randomUUID().slice(0, 8)}`;
        await wsApp.connectWith(wsStream, async (ctx) => {
            await ctx.initialized;
            await ctx.request(methods.agent.session.resume, {
                sessionId: acpSessionId,
                cwd: sandbox,
            });
            await waitFor(
                () => liveUpdates.filter((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
                (items) => items.length >= 1,
                { timeoutMs: 10_000 },
            );
            liveUpdates.length = 0;
            await ctx.request(methods.agent.session.prompt, {
                sessionId: acpSessionId,
                prompt: [{
                    type: "text",
                    text: `Run a shell command that writes the exact line \`${stampValue}\` into \`approved.txt\` in the project root, then confirm.`,
                }],
            });
            await waitFor(
                () => liveUpdates,
                (items) => {
                    const runningIdx = items.findIndex((u) => u.sessionUpdate === "state_update" && u.state === "running");
                    return runningIdx >= 0 && items.slice(runningIdx + 1).some((u) => u.sessionUpdate === "state_update" && u.state === "idle");
                },
                { timeoutMs: 120_000 },
            );
        });

        assert.ok(permissions.length >= 1, "host-effect proposal triggered session/request_permission over ACPv2");
        assert.equal((await readFile(join(sandbox, "approved.txt"), "utf8")).trim(), stampValue);

        const requestsBeforeReplay = (await db.test_count_provider_requests?.get?.<{ n: number }>())?.n;

        // 5. Fresh WebSocket connection: `session/resume` with `replayFrom: { type: "start" }` replays
        // prior session updates through `replay_complete` with zero new model calls.
        const replayUpdates: SessionUpdate[] = [];
        const replayStream = createWebSocketStream(`ws://127.0.0.1:${port}/acp`, {
            WebSocket: WsConstructor,
            headers: { authorization: `Bearer ${accessToken}` },
        });
        const replayApp = makeClientApp().onNotification(methods.client.session.update, ({ params }) => {
            replayUpdates.push(params.update);
        });
        await replayApp.connectWith(replayStream, async (ctx) => {
            await ctx.initialized;
            await ctx.request(methods.agent.session.resume, {
                sessionId: acpSessionId,
                cwd: sandbox,
                replayFrom: { type: "start" },
            });
            await waitFor(
                () => replayUpdates.filter((u) => u.sessionUpdate === "replay_complete"),
                (items) => items.length === 1,
                { timeoutMs: 10_000 },
            );
        });
        assert.ok(
            replayUpdates.some((u) => u.sessionUpdate === "agent_message_chunk"),
            "session/resume replayed the completed assistant message chunks",
        );
        if (requestsBeforeReplay !== undefined) {
            const requestsAfterReplay = (await db.test_count_provider_requests?.get?.<{ n: number }>())?.n;
            assert.equal(requestsAfterReplay, requestsBeforeReplay, "replay issued zero model requests");
        }
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        run.finish();
    }
});
