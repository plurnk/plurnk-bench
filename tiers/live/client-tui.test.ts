// {§test-artifact-retention} — the terminal client's own real-model tier, driven from the service's live tier so
// it has a census row: the client checkout (PLURNK_CLIENT_CHECKOUT, else `../plurnk`) runs
// `npm run test:tui:live` against this checkout's service on the active route; its output lands in
// the run directory. Skips by name when there is no client checkout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { liveRun } from "@plurnk/plurnk-service/harness";
import { checkoutPath } from "@plurnk/plurnk-service/harness";

const SERVICE = resolve(process.env.PLURNK_SERVICE_CHECKOUT ?? join(process.cwd(), ".."));

test("live client: the terminal client's real-model TUI tier passes against this service", {
    timeout: 900_000,
    requires: ["checkout:client"],
}, async () => {
    const client = checkoutPath("client");
    const run = await liveRun("live-client-tui", { database: false });
    const output = createWriteStream(join(run.runDir, "client.log"));
    let transcript = "";
    try {
        // The client's tier is its own node:test run; the runner's context mark on this process would
        // make a nested runner refuse its files, so the child does not inherit it.
        const env: NodeJS.ProcessEnv = { ...process.env, PLURNK_SERVICE_CHECKOUT: SERVICE };
        delete env.NODE_TEST_CONTEXT;
        const child = spawn("npm", ["run", "-s", "test:tui:live"], { cwd: client, env, stdio: ["ignore", "pipe", "pipe"] });
        for (const stream of [child.stdout, child.stderr]) {
            stream.setEncoding("utf8");
            stream.on("data", (chunk: string) => { transcript += chunk; });
            stream.pipe(output, { end: false });
        }
        const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
        output.end();
        await once(output, "finish");
        assert.equal(code, 0, `the client's tier exited ${code ?? signal}; its log is ${join(run.runDir, "client.log")}`);
        assert.match(transcript, /ℹ fail 0\b/u, "no client check failed");
        assert.match(transcript, /ℹ skipped 0\b/u, "the client found this service and skipped nothing");
        assert.doesNotMatch(transcript, /ℹ pass 0\b/u, "the client ran its check");
    } finally {
        output.destroy();
        run.finish();
    }
});
