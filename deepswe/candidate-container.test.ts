// {§benchlet-container-exec} — the container lifecycle as a unit: exact docker invocations, one
// removal on stop, idempotent stop, and a failed start that leaves nothing behind.
import test from "node:test";
import assert from "node:assert/strict";
import CandidateContainer, { type ContainerRunner } from "./candidate-container.ts";

const environment = { image: "ghcr.io/example/task:sha-1", network: "none", cpus: 2, memoryMb: 4096 };
const repository = "/runs/run7/repo";

const recorder = (behavior: (command: string, args: string[]) => string = () => "") => {
    const calls: Array<{ command: string; args: string[]; allowFailure?: boolean }> = [];
    const run: ContainerRunner = (command, args, options) => { calls.push({ command, args, ...(options?.allowFailure ? { allowFailure: true } : {}) }); return behavior(command, args); };
    return { calls, run };
};

test("[§benchlet-container-exec] start creates the container from the manifest with both mounts, then starts it", () => {
    const { calls, run } = recorder((_c, args) => (args[0] === "create" ? "c0ffee\n" : ""));
    const container = new CandidateContainer(run);
    assert.equal(container.start(environment, repository), "c0ffee");
    assert.deepEqual(calls, [
        { command: "docker", args: ["create", "--network", "none", "--cpus", "2", "--memory", "4096m", "-v", "/runs/run7/repo:/runs/run7/repo", "-v", "/runs/run7/repo:/app", "-w", "/runs/run7/repo", "ghcr.io/example/task:sha-1", "sleep", "infinity"] },
        { command: "docker", args: ["start", "c0ffee"] },
    ]);
    assert.equal(container.active, "c0ffee");
    assert.deepEqual(container.record(environment, repository, ["sh", "node"]), {
        kind: "task-container", image: environment.image, network: "none", container: "c0ffee", mounts: [repository, "/app"], executors: ["sh", "node"],
    });
});

test("[§benchlet-container-exec] stop removes the container once; a second stop and a stop before start do nothing", () => {
    const { calls, run } = recorder((_c, args) => (args[0] === "create" ? "c0ffee" : ""));
    const container = new CandidateContainer(run);
    container.stop();
    assert.deepEqual(calls, [], "nothing to remove before a start");
    container.start(environment, repository);
    container.stop();
    container.stop();
    assert.deepEqual(calls.slice(2), [{ command: "docker", args: ["rm", "--force", "c0ffee"], allowFailure: true }], "exactly one removal");
    assert.equal(container.active, undefined);
    assert.throws(() => container.record(environment, repository, []), /not active/);
});

test("[§benchlet-container-exec] a start that fails removes the created container and leaves nothing active", () => {
    const { calls, run } = recorder((_c, args) => { if (args[0] === "create") return "dead00"; if (args[0] === "start") throw new Error("no such image"); return ""; });
    const container = new CandidateContainer(run);
    assert.throws(() => container.start(environment, repository), { message: "candidate container dead00 did not start" });
    assert.deepEqual(calls.at(-1), { command: "docker", args: ["rm", "--force", "dead00"], allowFailure: true });
    assert.equal(container.active, undefined);
    container.stop();
    assert.equal(calls.length, 3, "stop after a failed start removes nothing twice");
});

test("[§benchlet-container-exec] a second start while one is active is refused rather than leaking the first", () => {
    const { run } = recorder((_c, args) => (args[0] === "create" ? "c0ffee" : ""));
    const container = new CandidateContainer(run);
    container.start(environment, repository);
    assert.throws(() => container.start(environment, repository), /already active/);
});
