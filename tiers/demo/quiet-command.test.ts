// {§session-wait-timing}: outcome-oriented recovery from a service that leaves its first request unanswered.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveLoop, liveWorkspace } from "@plurnk/plurnk-service/harness";
import { failAfterCleanup } from "@plurnk/plurnk-service/harness";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { initializeDemoRepository } from "@plurnk/plurnk-service/harness";

test("demo: recover a quiet stock-report command and deliver its result", async (t) => {
    const lifetime = new AsyncDisposableStack();
    const sandbox = await mkdtemp(join(tmpdir(), "plurnk-demo-quiet-command-"));
    lifetime.defer(() => rm(sandbox, { recursive: true, force: true }));
    const marker = `STOCK_${crypto.randomUUID()}`;
    let requests = 0;
    const server = createServer((_request, response) => {
        if (++requests === 1) return;
        response.end(marker);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    lifetime.defer(() => new Promise<void>((resolve, reject) => {
        server.close((cause) => cause === undefined ? resolve() : reject(cause));
        server.closeAllConnections();
    }));
    const prior = process.env.PLURNK_SERVICE_WAIT_SEC;
    process.env.PLURNK_SERVICE_WAIT_SEC = "1";
    lifetime.defer(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
        else process.env.PLURNK_SERVICE_WAIT_SEC = prior;
    });
    try {
        const { port } = server.address() as AddressInfo;
        await writeFile(join(sandbox, "report.mjs"),
            `const response = await fetch("http://127.0.0.1:${port}/stock");\nconsole.log(await response.text());\n`);
        initializeDemoRepository(sandbox, "stock report");
        const s = await liveWorkspace({ name: `demo-quiet-command-${crypto.randomUUID()}`, projectRoot: sandbox });
        lifetime.defer(s.cleanup);
        const result = await liveLoop(s, 2, {
            prompt: "Please run report.mjs and tell me the current stock report.",
            maxTurns: 16,
        }, { signal: t.signal });
        assert.equal(result.finalStatus, 200, "the task finishes without human intervention");
        assert.ok(result.lastContent.includes(marker), "the answer contains the service's actual report");
        assert.ok(requests > 1, "the unanswered request was recovered rather than mistaken for the result");
    } catch (cause) {
        await failAfterCleanup(cause, () => lifetime.disposeAsync());
    }
    await lifetime.disposeAsync();
});
