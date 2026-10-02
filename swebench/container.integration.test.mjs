import assert from "node:assert/strict";
import test from "node:test";
import { access, cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { runContainer } from "./container.ts";
import { dockerImageId, prepareRepository, candidateArgv, shell } from "./run.ts";
import { benchmarksHome } from "../src/host-paths.ts";
import { piArguments } from "./pi.mjs";

const image = "swebench/sweb.eval.x86_64.django_1776_django-11620:latest";
async function fixture(kind) {
    const parent = join(benchmarksHome(), "jobs", "adapter-tests");
    await mkdir(parent, { recursive: true });
    const trial = await mkdtemp(join(parent, `${kind}-`));
    console.log(`adapter evidence: ${trial}`);
    const runtime = join(trial, "runtime");
    await cp(process.env[`PLURNK_BENCH_${kind.toUpperCase()}_RUNTIME`], runtime, { recursive: true, verbatimSymlinks: true });
    await copyFile(join(runtime, "runner.mjs"), join(runtime, "production-runner.mjs"));
    await copyFile(join(import.meta.dirname, "fixtures/container-model.mjs"), join(runtime, "runner.mjs"));
    const repository = join(trial, "repo");
    const agent = join(trial, "agent");
    await mkdir(agent);
    prepareRepository({ environment: { image } }, repository);
    // Plurnk's Git membership admits tracked files. The shell then changes the
    // same admitted resource that native READ/EDIT must observe.
    await writeFile(join(repository, "native.txt"), "fixture seed\n");
    shell("git", ["-C", repository, "add", "native.txt"]);
    return { trial, runtime, repository, agent, image: dockerImageId(image), cpus: 2, memoryMb: 4096,
        allowedHosts: ["example.com"], preflight: false, env: {},
        argv: kind === "plurnk" ? candidateArgv("/testbed", 60, "Run the deterministic adapter check.", 8)
            : ["pi", ...piArguments({ provider: "openrouter", model: "fixture", effort: "high" }, "/logs/agent/sessions",
                "Run the deterministic adapter check.", "/opt/harness/pi-extension.mjs")],
    };
}

for (const kind of ["plurnk", "pi"]) test(`{§swebench-container-runtime} installed ${kind}: native/shell identity`, {
    skip: !process.env[`PLURNK_BENCH_${kind.toUpperCase()}_RUNTIME`], timeout: 180000,
}, async (t) => {
    const request = await fixture(kind);
    const { trial, repository, agent } = request;
    const result = await runContainer(request, { signal: t.signal, timeoutMs: 120000 });
    assert.equal(result.status, 0, await readFile(join(trial, "container.stderr.log"), "utf8"));
    assert.equal((await readFile(join(repository, "native.txt"), "utf8")).trim(), "native edited");
    const requests = JSON.parse(await readFile(join(agent, "fixture.requests.json"), "utf8"));
    assert.equal(requests.length, 5);
    if (kind === "plurnk") {
        const digest = JSON.parse(await readFile(join(agent, "digest/digest.json"), "utf8"));
        const reads = digest.log_entries.filter((row) => row.op === "READ" && row.target === "native.txt");
        assert.equal(reads.length, 2, "relative and absolute native READ address one file");
        assert.ok(reads.every((row) => row.status_rx === 200));
        assert.deepEqual(digest.log_entries.filter((row) => row.status_rx >= 400), [], "no operation failed behind the final answer");
        assert.ok(digest.log_entries.some((row) => row.op === "node" && row.status_rx === 200));
        assert.match(await readFile(join(repository, "probe.js"), "utf8"), /NODE_READ=/);
        await assert.rejects(access(join(repository, "testbed")), { code: "ENOENT" });
        assert.doesNotMatch(JSON.stringify(requests[0].messages), /```lua /, "missing optional interpreter is not advertised");
        assert.match(await readFile(join(agent, "plurnk.stdout.log"), "utf8"), /FIXTURE_COMPLETE/);
    } else assert.match(await readFile(join(agent, "pi.stdout.jsonl"), "utf8"), /FIXTURE_COMPLETE/);
    // Completed fixture data is reproducible; retain only failure evidence.
    await rm(trial, { recursive: true });
});

test("{§swebench-executor-encoding} installed runtime preflight uses the task toolchain without inference or network", {
    skip: !process.env.PLURNK_BENCH_PLURNK_RUNTIME, timeout: 60000,
}, async (t) => {
    const parent = join(benchmarksHome(), "jobs", "adapter-tests");
    await mkdir(parent, { recursive: true });
    const trial = await mkdtemp(join(parent, "preflight-"));
    const repository = join(trial, "repo"), agent = join(trial, "agent");
    await mkdir(agent);
    prepareRepository({ environment: { image } }, repository);
    const result = await runContainer({ trial, repository, agent, runtime: process.env.PLURNK_BENCH_PLURNK_RUNTIME,
        image: dockerImageId(image), cpus: 1, memoryMb: 512, allowedHosts: [], preflight: true,
        argv: ["plurnk", "--preflight"], env: {},
    }, { signal: t.signal, timeoutMs: 45000 });
    assert.equal(result.status, 0, await readFile(join(trial, "container.stderr.log"), "utf8"));
    const record = JSON.parse(await readFile(join(agent, "preflight.json"), "utf8"));
    assert.equal(record.node, process.version);
    assert.equal(record.cwd, "/testbed");
    assert.match(record.python, /\/opt\/miniconda3\/envs\/testbed\/bin\/python\nUnicode ✓/);
    assert.equal(record.shell, "Unicode ✓");
    await assert.rejects(access(join(agent, "plurnk.db")), { code: "ENOENT" });
    await rm(trial, { recursive: true });
});

test("{§swebench-container-runtime} cancellation drains only its candidate and preserves its digest", {
    skip: !process.env.PLURNK_BENCH_PLURNK_RUNTIME || !process.env.PLURNK_BENCH_PI_RUNTIME,
    timeout: 180000,
}, async (t) => {
    const requests = await Promise.all([fixture("pi"), fixture("plurnk")]);
    const controllers = requests.map(() => new AbortController());
    const results = requests.map((request, index) => runContainer({ ...request, env: { FIXTURE_WAIT: "1" } }, {
        signal: AbortSignal.any([controllers[index].signal, t.signal]), timeoutMs: 120000,
    }));
    t.after(async () => {
        controllers.forEach((controller) => controller.abort());
        await Promise.allSettled(results);
    });
    const containers = (request) => shell("docker", ["ps", "-aq", "--filter",
        `label=com.docker.compose.project=${basename(request.trial).toLowerCase()}`]).trim();
    const pending = await Promise.all(requests.map(async ({ agent }) => {
        for (;;) {
            try { return JSON.parse(await readFile(join(agent, "fixture.requests.json"), "utf8")); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            await setTimeout(200, undefined, { signal: t.signal });
        }
    }));
    assert.ok(pending.every((calls) => calls.length === 1), "both real clients are awaiting their independent provider");
    assert.ok(requests.every((request) => containers(request)), "both trial containers are running");
    const peers = await Promise.all(requests.map(async (request) => {
        const members = JSON.parse(shell("docker", ["inspect", ...containers(request).split("\n")]));
        const main = members.find((member) => member.Config.Labels["com.docker.compose.service"] === "main");
        const sidecar = members.find((member) => member.Config.Labels["com.docker.compose.service"] === "harbor-docker-egress-control-sidecar");
        const networks = Object.entries(sidecar.NetworkSettings.Networks);
        assert.equal(networks.length, 1);
        const [network, details] = networks[0];
        assert.notEqual(network, "bridge", "the candidate does not join Docker's shared bridge");
        assert.equal(main.HostConfig.NetworkMode, `container:${sidecar.Id}`, "the candidate shares the filtered namespace");
        const { port } = JSON.parse(await readFile(join(request.agent, "fixture.endpoint.json"), "utf8"));
        return { main: main.Id, network, address: details.IPAddress, port };
    }));
    assert.notEqual(peers[0].network, peers[1].network, "trials own different networks");
    for (const [index, peer] of peers.entries()) {
        const other = peers[1 - index];
        shell("docker", ["exec", peer.main, "/opt/harness/bin/node", "--input-type=module", "-e", `
            import assert from "node:assert/strict";
            assert.equal(await (await fetch("http://127.0.0.1:${peer.port}/isolation-check")).text(), "trial-listener");
            for (const headers of [{}, { host: "example.com" }]) {
                await assert.rejects(fetch("http://${other.address}:${other.port}/isolation-check", {
                    headers, signal: AbortSignal.timeout(4000),
                }));
            }
        `]);
    }
    controllers[0].abort();
    const first = await results[0];
    assert.equal(first.cancelled, true);
    assert.equal(first.status, 143);
    assert.equal(containers(requests[0]), "", "the cancelled Pi trial is removed");
    assert.ok(containers(requests[1]), "the independent Plurnk trial remains alive");
    await access(join(requests[1].agent, "runner.pid"));
    controllers[1].abort();
    const second = await results[1];
    assert.equal(second.cancelled, true);
    assert.equal(second.status, 143);
    assert.equal(containers(requests[1]), "");
    await assert.rejects(access(join(requests[1].agent, "runner.pid")), { code: "ENOENT" });
    const digest = JSON.parse(await readFile(join(requests[1].agent, "digest/digest.json"), "utf8"));
    assert.ok(digest.loops.length > 0, "the stopped daemon leaves readable loop evidence");
    for (const request of requests) await rm(request.trial, { recursive: true });
});

for (const mode of ["allowlist", "none"]) test(`{§swebench-network} Harbor enforces ${mode} for hostnames and direct IPs`, {
    skip: !process.env.PLURNK_BENCH_PLURNK_RUNTIME, timeout: 60000,
}, async (t) => {
    const parent = join(benchmarksHome(), "jobs", "adapter-tests");
    await mkdir(parent, { recursive: true });
    const trial = await mkdtemp(join(parent, "network-"));
    console.log(`network evidence: ${trial}`);
    const runtime = join(trial, "runtime");
    await mkdir(join(runtime, "bin"), { recursive: true });
    await copyFile(join(process.env.PLURNK_BENCH_PLURNK_RUNTIME, "bin/node"), join(runtime, "bin/node"));
    await copyFile(join(import.meta.dirname, "fixtures/container-model.mjs"), join(runtime, "runner.mjs"));
    const repository = join(trial, "repo"), agent = join(trial, "agent");
    await mkdir(repository); await mkdir(agent);
    const result = await runContainer({ trial, runtime, repository, agent, image: dockerImageId(image), cpus: 1, memoryMb: 512,
        allowedHosts: mode === "allowlist" ? ["example.com"] : [], preflight: mode === "none",
        argv: ["plurnk"], env: { FIXTURE_NETWORK: mode },
    }, { signal: t.signal, timeoutMs: 45000 });
    assert.equal(result.status, 0, await readFile(join(trial, "container.stderr.log"), "utf8"));
    const network = JSON.parse(await readFile(join(agent, "network.json"), "utf8"));
    if (mode === "allowlist") assert.ok(network.allowed >= 100);
    else assert.equal(network.allowed, null);
    assert.equal(network.denied, true);
    assert.equal(network.directIpDenied, true);
    await rm(trial, { recursive: true });
});
