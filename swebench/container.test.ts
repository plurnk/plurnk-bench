import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { modelHosts, runContainer, type ContainerRequest } from "./container.ts";

test("{§swebench-network} egress is explicit, with no-network valid only for preflight", () => {
    assert.deepEqual(modelHosts({}, true), []);
    assert.throws(() => modelHosts({}, false), /model endpoint/);
    assert.deepEqual(modelHosts({ PLURNK_SWEBENCH_MODEL_HOSTS: '["api.example.com"]' }, false), ["api.example.com"]);
    for (const value of ['["https://api.example.com"]', '"public"', '[""]', '[3]']) {
        assert.throws(() => modelHosts({ PLURNK_SWEBENCH_MODEL_HOSTS: value }, false), /host names/);
    }
});

test("{§swebench-container-runtime} cancellation does not interrupt draining a second time at the wall-clock deadline", { timeout: 5000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "candidate-drain-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "fixture.mjs");
    await writeFile(executable, `#!/usr/bin/env node
let input = "";
for await (const part of process.stdin) input += part;
const {trial} = JSON.parse(input);
const {writeFileSync} = await import("node:fs");
let signals = 0;
process.on("SIGTERM", () => {
    signals++;
    setTimeout(() => {console.log("signals=" + signals); process.exit(143);}, 600);
});
writeFileSync(trial + "/ready", "ready");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const controller = new AbortController();
    const request: ContainerRequest = { trial: root, runtime: root, repository: root, agent: root,
        image: "fixture", cpus: 1, memoryMb: 512, allowedHosts: ["provider.example"],
        preflight: false, argv: ["plurnk"], env: {} };
    const result = runContainer(request, { python: executable, signal: controller.signal, timeoutMs: 500 });
    for (;;) {
        try { await readFile(join(root, "ready")); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await setTimeout(10, undefined, { signal: t.signal });
    }
    controller.abort();
    const exited = await result;
    assert.equal(exited.status, 143);
    assert.equal(exited.cancelled, true);
    assert.equal(exited.timedOut, false);
    assert.equal(await readFile(join(root, "container.stdout.log"), "utf8"), "signals=1\n");
});

test("{§swebench-container-runtime} credentials cross stdin, not files or process arguments", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "candidate-boundary-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = join(root, "fixture.mjs");
    await writeFile(executable, `#!/usr/bin/env node
let input = "";
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
if (request.env.PROVIDER_API_KEY !== "fixture-secret") process.exit(5);
if (process.argv.some((arg) => arg.includes("fixture-secret"))) process.exit(6);
if (request.resolverConfig !== "/configured/resolv.conf") process.exit(7);
console.log("received through stdin");
`, { mode: 0o755 });
    const request: ContainerRequest = { trial: root, runtime: root, repository: root, agent: root,
        image: "fixture", cpus: 1, memoryMb: 512, allowedHosts: ["provider.example"],
        preflight: false, argv: ["plurnk"], env: { PROVIDER_API_KEY: "fixture-secret" } };
    const result = await runContainer(request, { python: executable, resolverConfig: "/configured/resolv.conf" });
    assert.equal(result.status, 0);
    assert.equal(await readFile(join(root, "container.stdout.log"), "utf8"), "received through stdin\n");
    assert.equal(await readFile(join(root, "container.stderr.log"), "utf8"), "");
});
