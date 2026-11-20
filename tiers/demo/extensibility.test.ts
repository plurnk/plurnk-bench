// {§tier-corpus} — bounded, oracle-verified `/notifications` webhook integration demo (#972).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import {
    bindListener,
    Daemon,
    initializeDemoRepository,
    liveLoop,
    liveTest as test,
    liveWorkspace,
    makeMockResponse,
    openMigrated,
    ResourceState,
    waitFor,
} from "@plurnk/plurnk-service/harness";

test("demo: watch plurnk /notifications SSE and forward loop/terminated events to a webhook", { timeout: 600_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-demo-extend-watch-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    initializeDemoRepository(root, "empty project");

    const s = await liveWorkspace({ name: `demo-extend-watch-${crypto.randomUUID()}`, projectRoot: root });
    try {
        const result = await liveLoop(
            s,
            2,
            {
                prompt: [
                    "Write a standalone Node.js ESM script at `watch-loops.mjs` in this project that:",
                    "1. Connects to a Plurnk daemon's SSE stream at `process.env.PLURNK_NOTIFICATIONS_URL` (`Accept: text/event-stream`).",
                    "2. Whenever an SSE frame with `event: loop/terminated` arrives, parses its JSON `data` envelope and sends an HTTP `POST` (`Content-Type: application/json`) to `process.env.WEBHOOK_URL` containing `{ event: envelope.event, workspaceId: envelope.workspaceId, sessionId: envelope.sessionId, status: envelope.data?.result?.status ?? null }`.",
                    "Do not leave `watch-loops.mjs` running in the background when you finish.",
                ].join("\n"),
                maxTurns: 20,
            },
            { signal: t.signal },
        );
        assert.equal(result.finalStatus, 200, "the authoring loop concludes cleanly");
        assert.deepEqual(await ResourceState.check(s.db), [], "the workspace stays lawful");
    } finally {
        await s.cleanup();
    }

    const scriptPath = join(root, "watch-loops.mjs");
    assert.equal(existsSync(scriptPath), true, "watch-loops.mjs was written to the project root");

    // Independent execution oracle: boot an ephemeral Mock daemon + local webhook server, run
    // the model's `watch-loops.mjs`, trigger a real `loop/terminated` SSE frame, and verify delivery.
    const received: Array<Record<string, unknown>> = [];
    const webhookServer = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            try {
                received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
                res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
            } catch {
                res.writeHead(400).end();
            }
        });
    });
    await new Promise<void>((resolve) => webhookServer.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => webhookServer.close(() => resolve())));
    const webhookPort = (webhookServer.address() as AddressInfo).port;

    const oracleDb = await openMigrated();
    const oracleHttp = await bindListener();
    const oracleProvider = new Mock({
        contextWindow: 128_000,
        responses: [
            makeMockResponse('plurnk.done({ text: "oracle-one" })'),
            makeMockResponse('plurnk.done({ text: "oracle-two" })'),
            makeMockResponse('plurnk.done({ text: "oracle-three" })'),
        ],
    });
    const oracleDaemon = new Daemon({ db: oracleDb, provider: oracleProvider, http: oracleHttp });
    await oracleDaemon.start();
    t.after(async () => {
        await oracleDaemon.stop();
        await oracleHttp.close();
        await oracleDb.close();
    });
    const { port: daemonPort } = oracleHttp.httpAddress();
    const { workspaceId } = await oracleDaemon.createWorkspace({ name: "oracle-ws" });

    const watcherAbort = new AbortController();
    const watcherStderr: string[] = [];
    const watcher = spawn(process.execPath, [scriptPath], {
        cwd: root,
        env: {
            ...process.env,
            PLURNK_NOTIFICATIONS_URL: `http://127.0.0.1:${daemonPort}/notifications`,
            WEBHOOK_URL: `http://127.0.0.1:${webhookPort}/webhook`,
        },
        signal: watcherAbort.signal,
        stdio: ["ignore", "pipe", "pipe"],
    });
    watcher.stderr.setEncoding("utf8");
    watcher.stderr.on("data", (chunk: string) => watcherStderr.push(chunk));
    t.after(() => watcherAbort.abort());

    // Give the watcher up to 3 quick loop runs in case the first fires while Node is still booting.
    for (let attempt = 1; attempt <= 3 && received.length === 0; attempt++) {
        await new Promise((r) => setTimeout(r, 250));
        const { sessionId } = await oracleDaemon.createSession({ workspaceId, name: `probe-${attempt}` });
        await oracleDaemon.runLoop({ workspaceId, sessionId, prompt: "ping" });
        await new Promise((r) => setTimeout(r, 250));
    }

    await waitFor(
        () => received,
        (items) => items.length >= 1,
        { timeoutMs: 5_000 },
    ).catch((err) => {
        throw new Error(`Webhook never received loop/terminated payload (${String(err)}); watcher stderr: ${watcherStderr.join("")}`);
    });
    assert.equal(received[0].event, "loop/terminated");
    assert.equal(received[0].workspaceId, workspaceId);
    assert.equal(received[0].status, 200);
});
