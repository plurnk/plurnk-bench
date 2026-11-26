import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runContainer, type ContainerRequest } from "./container.ts";
import { withBuildWorktree } from "./runtime.ts";
import { acquireLoopbackSlotLeases, acquirePortSlot, probeLocalSlots } from "./slot-lease.ts";

test("{§swebench-evaluator} probeLocalSlots discovers llama-server total_slots, honors PLURNK_BENCH_LOCAL_SLOTS, and ignores non-llama servers", async (t) => {
    const llama = createServer((req, res) => {
        if (req.url === "/props") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ total_slots: 2, default_generation_settings: { n_ctx: 32768 } }));
            return;
        }
        res.writeHead(404).end();
    });
    llama.listen(0, "127.0.0.1");
    await once(llama, "listening");
    t.after(() => { llama.closeAllConnections(); llama.close(); });
    const llamaPort = (llama.address() as { port: number }).port;

    const plain = createServer((_req, res) => res.writeHead(404).end("not llama"));
    plain.listen(0, "127.0.0.1");
    await once(plain, "listening");
    t.after(() => { plain.closeAllConnections(); plain.close(); });
    const plainPort = (plain.address() as { port: number }).port;

    assert.equal(await probeLocalSlots(llamaPort, { slotsOverride: "" }), 2);
    assert.equal(await probeLocalSlots(plainPort, { slotsOverride: "" }), null);
    assert.equal(await probeLocalSlots(llamaPort, { slotsOverride: "0" }), null, "0 explicitly disables slot leasing");
    assert.equal(await probeLocalSlots(plainPort, { slotsOverride: "3" }), 3, "positive override forces finite slot count");
    for (const invalid of ["-1", "abc", "1.5"]) {
        await assert.rejects(() => probeLocalSlots(llamaPort, { slotsOverride: invalid }), /PLURNK_BENCH_LOCAL_SLOTS/u);
    }
});

test("{§swebench-evaluator} host-side flock slot leases serialize total_slots=1 and cap total_slots=2 across concurrent runContainer trials without charging queue wait to timeoutMs", async (t) => {
    for (const totalSlots of [1, 2] as const) {
        await t.test(`{§swebench-evaluator} total_slots=${totalSlots}`, async (t) => {
            const root = await mkdtemp(join(tmpdir(), `slot-lease-matrix-${totalSlots}-`));
            t.after(() => rm(root, { recursive: true, force: true }));
            const slotRoot = join(root, "slots");
            const activeLog = join(root, "events.jsonl");

            const server = createServer((req, res) => {
                if (req.url === "/props") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ total_slots: totalSlots }));
                    return;
                }
                res.writeHead(200).end("ok");
            });
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            t.after(() => { server.closeAllConnections(); server.close(); });
            const port = (server.address() as { port: number }).port;

            const executable = join(root, "fixture.mjs");
            await writeFile(executable, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
let input = "";
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
const id = request.argv[1];
appendFileSync(${JSON.stringify(activeLog)}, JSON.stringify({ id, kind: "enter", at: Date.now() }) + "\\n");
await delay(180);
appendFileSync(${JSON.stringify(activeLog)}, JSON.stringify({ id, kind: "leave", at: Date.now() }) + "\\n");
`, { mode: 0o755 });

            const trialCount = totalSlots === 1 ? 3 : 4;
            const acquiredAt: number[] = [];
            const results = await Promise.all(Array.from({ length: trialCount }, async (_, index) => {
                const trialDir = join(root, `trial-${index}`);
                mkdirSync(trialDir, { recursive: true });
                const request: ContainerRequest = {
                    trial: trialDir,
                    runtime: trialDir,
                    repository: trialDir,
                    agent: trialDir,
                    image: "fixture",
                    cpus: 1,
                    memoryMb: 512,
                    allowedHosts: [],
                    preflight: false,
                    argv: ["plurnk", `t${index}`],
                    env: { OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1` },
                };
                // Tight 500ms timeout would fail queued trials if timer ticked before slot acquisition (3 * 180ms = 540ms > 500ms).
                return await runContainer(request, {
                    python: executable,
                    slotRoot,
                    timeoutMs: 500,
                    onSlotAcquired: () => { acquiredAt.push(Date.now()); },
                });
            }));

            assert.equal(acquiredAt.length, trialCount);
            for (const result of results) {
                assert.equal(result.status, 0);
                assert.equal(result.timedOut, false, "host queue wait must not consume container timeoutMs");
            }
            const events = (await readFile(activeLog, "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as { id: string; kind: "enter" | "leave" });
            let active = 0;
            let peak = 0;
            for (const event of events) {
                active += event.kind === "enter" ? 1 : -1;
                if (active > peak) peak = active;
            }
            assert.equal(active, 0);
            assert.ok(peak <= totalSlots, `peak concurrent trials ${peak} must not exceed total_slots=${totalSlots}`);
            if (totalSlots === 2) {
                assert.equal(peak, 2, "multi-slot endpoint runs up to total_slots trials in parallel");
            }
        });
    }
});

test("{§swebench-evaluator} queued slot lease aborts cleanly on signal and recovers immediately when a holding process dies via SIGKILL", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "slot-lease-crash-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const slotRoot = join(root, "slots");

    // 1. Abort while queued behind slot 0.
    const first = await acquirePortSlot(11435, 1, { slotRoot });
    const abort = new AbortController();
    const waiter = acquirePortSlot(11435, 1, { slotRoot, signal: abort.signal });
    await delay(80);
    abort.abort(new Error("cancelled while waiting"));
    await assert.rejects(waiter, /cancelled while waiting/u);
    await first.release();

    // 2. Acquire across multiple sorted ports and release cleanly on release().
    const multi = await acquireLoopbackSlotLeases([11436, 11435, 11435], {
        slotRoot,
        probe: async () => 1,
    });
    assert.deepEqual(multi.leases.map((lease) => lease.port), [11435, 11436]);
    await multi.release();

    // 3. Cross-process SIGKILL releases OS flock immediately with zero stale lockfile.
    const holder = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `import { acquirePortSlot } from ${JSON.stringify(join(import.meta.dirname, "slot-lease.ts"))};
         await acquirePortSlot(11437, 1, { slotRoot: ${JSON.stringify(slotRoot)} });
         process.stdout.write("HELD\\n");
         setInterval(() => {}, 60_000);`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolveReady, rejectReady) => {
        let out = "";
        holder.stdout.setEncoding("utf8");
        holder.stdout.on("data", (chunk: string) => {
            out += chunk;
            if (out.includes("HELD")) resolveReady();
        });
        holder.once("exit", (code) => rejectReady(new Error(`holder exited early: ${code}`)));
    });
    const next = acquirePortSlot(11437, 1, { slotRoot });
    await delay(80);
    holder.kill("SIGKILL");
    const recovered = await next;
    assert.equal(recovered.slot, 0);
    await recovered.release();
});

test("{§swebench-evaluator} withBuildWorktree isolates builds and node_modules symlinks without mutating the live repository checkout", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "runtime-worktree-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, "repo");
    const stage = join(root, "stage");
    mkdirSync(join(repo, "pkg-a"), { recursive: true });
    mkdirSync(join(repo, "node_modules", "@scope"), { recursive: true });
    mkdirSync(join(repo, "pkg-a", "node_modules"), { recursive: true });
    mkdirSync(join(repo, "dist"), { recursive: true });
    mkdirSync(stage, { recursive: true });

    writeFileSync(join(repo, "package.json"), '{"name":"fixture-root","private":true}\n');
    writeFileSync(join(repo, "pkg-a", "package.json"), '{"name":"@scope/pkg-a","version":"1.0.0"}\n');
    writeFileSync(join(repo, "pkg-a", "index.js"), "export const value = 1;\n");
    writeFileSync(join(repo, "dist", "live-sentinel.txt"), "do-not-wipe\n");
    writeFileSync(join(repo, "pkg-a", "node_modules", "nested.txt"), "nested-ok\n");
    await symlink("../../pkg-a", join(repo, "node_modules", "@scope", "pkg-a"));

    const git = (args: string[]) => {
        const proc = spawn("git", ["-C", repo, ...args], { stdio: "ignore" });
        return new Promise<void>((accept, reject) => proc.once("exit", (code) => code === 0 ? accept() : reject(new Error(`git ${args.join(" ")} failed (${code})`))));
    };
    await git(["init", "-q"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.test"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["config", "core.hooksPath", "/dev/null"]);
    await git(["add", "package.json", "pkg-a/package.json", "pkg-a/index.js"]);
    await git(["commit", "-q", "-m", "chore: initial fixture"]);

    const headProc = spawn("git", ["-C", repo, "rev-parse", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
    let sha = "";
    headProc.stdout.setEncoding("utf8");
    headProc.stdout.on("data", (chunk: string) => { sha += chunk; });
    await once(headProc, "exit");
    sha = sha.trim();

    const wtDir = join(stage, "wt");
    const observed = await withBuildWorktree(repo, sha, wtDir, async (worktree) => {
        // Workspace relative symlink resolves inside the throwaway worktree, not back into the live checkout.
        const linkedManifest = JSON.parse(readFileSync(join(worktree, "node_modules", "@scope", "pkg-a", "package.json"), "utf8"));
        const nested = readFileSync(join(worktree, "pkg-a", "node_modules", "nested.txt"), "utf8").trim();
        writeFileSync(join(worktree, "pkg-a", "index.js"), "export const value = 999;\n");
        return { linkedName: linkedManifest.name, nested };
    });

    assert.deepEqual(observed, { linkedName: "@scope/pkg-a", nested: "nested-ok" });
    assert.equal(existsSync(wtDir), false, "disposable worktree is removed on exit");
    assert.equal(readFileSync(join(repo, "dist", "live-sentinel.txt"), "utf8"), "do-not-wipe\n", "live dist is untouched");
    assert.equal(readFileSync(join(repo, "pkg-a", "index.js"), "utf8"), "export const value = 1;\n", "live source is untouched");
});
