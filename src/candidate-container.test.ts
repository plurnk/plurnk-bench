// {§benchlet-container-exec} — the container lifecycle as a unit: exact docker invocations, the image
// home handed to the host user, one removal on stop, idempotent stop, and a failed start that leaves
// nothing behind.
import test from "node:test";
import assert from "node:assert/strict";
import CandidateContainer, { type ContainerRunner } from "./candidate-container.ts";

const environment = { image: "ghcr.io/example/task:sha-1", network: "none", cpus: 2, memoryMb: 4096 };
const repository = "/runs/run7/repo";
const user = "1000:1000";
const image = (home: string) => (_c: string, args: string[]): string => (args[0] === "create" ? "c0ffee\n" : args[0] === "exec" && args[1] === "c0ffee" && args[2] === "sh" ? home : "");

const recorder = (behavior: (command: string, args: string[]) => string = () => "") => {
    const calls: Array<{ command: string; args: string[]; allowFailure?: boolean }> = [];
    const run: ContainerRunner = (command, args, options) => { calls.push({ command, args, ...(options?.allowFailure ? { allowFailure: true } : {}) }); return behavior(command, args); };
    return { calls, run };
};

test("[§benchlet-container-exec] start creates the container from the manifest with both mounts, starts it, and hands the image home to the host user", () => {
    const { calls, run } = recorder(image("/root\n"));
    const container = new CandidateContainer(run);
    assert.equal(container.start(environment, repository, user), "c0ffee");
    assert.deepEqual(calls, [
        { command: "docker", args: ["create", "--network", "none", "--cpus", "2", "--memory", "4096m", "-v", "/runs/run7/repo:/runs/run7/repo", "-v", "/runs/run7/repo:/app", "-w", "/runs/run7/repo", "ghcr.io/example/task:sha-1", "sleep", "infinity"] },
        { command: "docker", args: ["start", "c0ffee"] },
        { command: "docker", args: ["exec", "c0ffee", "sh", "-c", 'printf %s "$HOME"'] },
        { command: "docker", args: ["exec", "-u", "0", "c0ffee", "chown", "-R", "1000:1000", "/root"] },
    ]);
    assert.equal(container.active, "c0ffee");
    assert.equal(container.home, "/root");
    assert.deepEqual(container.record(environment, repository, ["sh", "node"]), {
        kind: "task-container", image: environment.image, network: "none", container: "c0ffee", home: "/root", mounts: [repository, "/app"], executors: ["sh", "node"],
    });
});

test("[§benchlet-container-exec] stop removes the container once; a second stop and a stop before start do nothing", () => {
    const { calls, run } = recorder(image("/root"));
    const container = new CandidateContainer(run);
    container.stop();
    assert.deepEqual(calls, [], "nothing to remove before a start");
    container.start(environment, repository, user);
    container.stop();
    container.stop();
    assert.deepEqual(calls.slice(4), [{ command: "docker", args: ["rm", "--force", "c0ffee"], allowFailure: true }], "exactly one removal");
    assert.equal(container.active, undefined);
    assert.equal(container.home, undefined);
    assert.throws(() => container.record(environment, repository, []), /not active/);
});

test("[§benchlet-container-exec] a start that fails removes the created container and leaves nothing active", () => {
    const { calls, run } = recorder((_c, args) => { if (args[0] === "create") return "dead00"; if (args[0] === "start") throw new Error("no such image"); return ""; });
    const container = new CandidateContainer(run);
    assert.throws(() => container.start(environment, repository, user), { message: "candidate container dead00 did not start" });
    assert.deepEqual(calls.at(-1), { command: "docker", args: ["rm", "--force", "dead00"], allowFailure: true });
    assert.equal(container.active, undefined);
    container.stop();
    assert.equal(calls.length, 3, "stop after a failed start removes nothing twice");
});

test("[§benchlet-container-exec] a second start while one is active is refused rather than leaking the first", () => {
    const { run } = recorder(image("/root"));
    const container = new CandidateContainer(run);
    container.start(environment, repository, user);
    assert.throws(() => container.start(environment, repository, user), /already active/);
});

test("[§benchlet-container-exec] an image whose home is empty or the filesystem root is refused and its container removed", () => {
    for (const home of ["", "/"]) {
        const { calls, run } = recorder(image(home));
        const container = new CandidateContainer(run);
        assert.throws(() => container.start(environment, repository, user), (error: Error) =>
            error.message === "candidate container c0ffee home could not be handed to 1000:1000"
            && (error.cause as Error).message === `image home ${JSON.stringify(home)} is not a directory to hand over`);
        assert.ok(!calls.some((call) => call.args.includes("chown")), "nothing is chowned");
        assert.deepEqual(calls.at(-1), { command: "docker", args: ["rm", "--force", "c0ffee"], allowFailure: true });
        assert.equal(container.active, undefined);
    }
});

test("[§benchlet-container-exec] a home handover that fails removes the container and leaves nothing active", () => {
    const { calls, run } = recorder((c, args) => { if (args.includes("chown")) throw new Error("read-only file system"); return image("/root")(c, args); });
    const container = new CandidateContainer(run);
    assert.throws(() => container.start(environment, repository, user), { message: "candidate container c0ffee home could not be handed to 1000:1000" });
    assert.deepEqual(calls.at(-1), { command: "docker", args: ["rm", "--force", "c0ffee"], allowFailure: true });
    assert.equal(container.active, undefined);
});
