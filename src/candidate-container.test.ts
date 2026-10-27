import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import CandidateContainer, { type ContainerRunner } from "./candidate-container.ts";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { candidateIsolation } from "./candidate-isolation.ts";
import { requiredClientCheckout } from "./client-checkout.ts";
import { packRecords, packedContracts } from "./npm-pack.ts";
import { webMaterializationProvenance } from "./web-materialization.ts";

// ─── candidate-container.test.ts ───
{
// {§benchlet-diagnostic} — the container lifecycle as a unit: exact docker invocations, the image
// home handed to the host user, one removal on stop, idempotent stop, and a failed start that leaves
// nothing behind. {§benchlet-diagnostic} — the executor scratch mount and the daemon knob.






const environment = { image: "ghcr.io/example/task:sha-1", network: "none", cpus: 2, memoryMb: 4096 };
const repository = "/runs/run7/repo";
const runDir = mkdtempSync(join(tmpdir(), "candidate-container-"));
const scratch = join(runDir, "exec-scratch");
const mounts = { repository, scratch };
const user = "1000:1000";
test.after(() => rmSync(runDir, { recursive: true, force: true }));
const image = (home: string) => (_c: string, args: string[]): string => (args[0] === "create" ? "c0ffee\n" : args[0] === "exec" && args[1] === "c0ffee" && args[2] === "sh" ? home : "");

const recorder = (behavior: (command: string, args: string[]) => string = () => "") => {
    const calls: Array<{ command: string; args: string[]; allowFailure?: boolean }> = [];
    const run: ContainerRunner = (command, args, options) => { calls.push({ command, args, ...(options?.allowFailure ? { allowFailure: true } : {}) }); return behavior(command, args); };
    return { calls, run };
};

test("{§benchlet-diagnostic} start creates the container from the manifest with the repository and scratch mounts, starts it, and hands the image home to the host user", () => {
    const { calls, run } = recorder(image("/root\n"));
    const container = new CandidateContainer(run);
    assert.equal(container.start(environment, mounts, user), "c0ffee");
    assert.deepEqual(calls, [
        { command: "docker", args: ["create", "--network", "none", "--cpus", "2", "--memory", "4096m", "-v", "/runs/run7/repo:/runs/run7/repo", "-v", "/runs/run7/repo:/app", "-v", `${scratch}:${scratch}`, "-w", "/runs/run7/repo", "ghcr.io/example/task:sha-1", "sleep", "infinity"] },
        { command: "docker", args: ["start", "c0ffee"] },
        { command: "docker", args: ["exec", "c0ffee", "sh", "-c", 'printf %s "$HOME"'] },
        { command: "docker", args: ["exec", "-u", "0", "c0ffee", "chown", "-R", "1000:1000", "/root"] },
    ]);
    assert.equal(container.active, "c0ffee");
    assert.equal(container.home, "/root");
    assert.deepEqual(container.record(environment, mounts, ["sh", "node"]), {
        kind: "task-container", image: environment.image, network: "none", container: "c0ffee", home: "/root", scratch, mounts: [repository, "/app", scratch], executors: ["sh", "node"],
    });
    container.stop();
});

test("{§benchlet-diagnostic} the daemon is pointed at the same absolute scratch directory the container mounts, created 0700 before the bind", (t) => {
    const { calls, run } = recorder(image("/root"));
    const container = new CandidateContainer(run);
    t.after(() => container.stop());
    assert.throws(() => container.daemonEnvironment(), /not active/, "no scratch before a start");
    assert.throws(() => container.start(environment, { repository, scratch: "exec-scratch" }, user), /absolute host directory/);
    assert.equal(calls.length, 0, "a relative scratch is refused before docker is asked");
    rmSync(scratch, { recursive: true, force: true });
    container.start(environment, { ...mounts, containerRoot: "/testbed" }, user);
    assert.ok(existsSync(scratch), "the scratch directory exists on the host before docker binds it");
    assert.equal(statSync(scratch).mode & 0o777, 0o700);
    const create = calls[0]!.args;
    assert.deepEqual(create.slice(create.indexOf("-v"), create.indexOf("-w")), ["-v", `${repository}:${repository}`, "-v", `${repository}:/testbed`, "-v", `${scratch}:${scratch}`]);
    assert.deepEqual(container.daemonEnvironment(), { PLURNK_SERVICE_EXEC_SCRATCH: scratch });
    assert.equal(container.record(environment, { ...mounts, containerRoot: "/testbed" }, []).scratch, scratch);
    container.stop();
    assert.throws(() => container.daemonEnvironment(), /not active/, "the knob does not outlive the mount");
});

test("{§benchlet-diagnostic} stop removes the container once; a second stop and a stop before start do nothing", () => {
    const { calls, run } = recorder(image("/root"));
    const container = new CandidateContainer(run);
    container.stop();
    assert.deepEqual(calls, [], "nothing to remove before a start");
    container.start(environment, mounts, user);
    container.stop();
    container.stop();
    assert.deepEqual(calls.slice(4), [{ command: "docker", args: ["rm", "--force", "c0ffee"], allowFailure: true }], "exactly one removal");
    assert.equal(container.active, undefined);
    assert.equal(container.home, undefined);
    assert.throws(() => container.record(environment, mounts, []), /not active/);
});

test("{§benchlet-diagnostic} a start that fails removes the created container and leaves nothing active", () => {
    const { calls, run } = recorder((_c, args) => { if (args[0] === "create") return "dead00"; if (args[0] === "start") throw new Error("no such image"); return ""; });
    const container = new CandidateContainer(run);
    assert.throws(() => container.start(environment, mounts, user), { message: "candidate container dead00 did not start" });
    assert.deepEqual(calls.at(-1), { command: "docker", args: ["rm", "--force", "dead00"], allowFailure: true });
    assert.equal(container.active, undefined);
    container.stop();
    assert.equal(calls.length, 3, "stop after a failed start removes nothing twice");
});

test("{§benchlet-diagnostic} a second start while one is active is refused rather than leaking the first", () => {
    const { run } = recorder(image("/root"));
    const container = new CandidateContainer(run);
    container.start(environment, mounts, user);
    assert.throws(() => container.start(environment, mounts, user), /already active/);
});

test("{§benchlet-diagnostic} an image whose home is empty or the filesystem root is refused and its container removed", () => {
    for (const home of ["", "/"]) {
        const { calls, run } = recorder(image(home));
        const container = new CandidateContainer(run);
        assert.throws(() => container.start(environment, mounts, user), (error: Error) =>
            error.message === "candidate container c0ffee home could not be handed to 1000:1000"
            && (error.cause as Error).message === `image home ${JSON.stringify(home)} is not a directory to hand over`);
        assert.ok(!calls.some((call) => call.args.includes("chown")), "nothing is chowned");
        assert.deepEqual(calls.at(-1), { command: "docker", args: ["rm", "--force", "c0ffee"], allowFailure: true });
        assert.equal(container.active, undefined);
    }
});

test("{§benchlet-diagnostic} a home handover that fails removes the container and leaves nothing active", () => {
    const { calls, run } = recorder((c, args) => { if (args.includes("chown")) throw new Error("read-only file system"); return image("/root")(c, args); });
    const container = new CandidateContainer(run);
    assert.throws(() => container.start(environment, mounts, user), { message: "candidate container c0ffee home could not be handed to 1000:1000" });
    assert.deepEqual(calls.at(-1), { command: "docker", args: ["rm", "--force", "c0ffee"], allowFailure: true });
    assert.equal(container.active, undefined);
});
}

// ─── candidate-client.test.ts ───
{
const execute = promisify(execFile);

test("{§bench-relock} a fresh client builds against the selected packed contracts without changing source or lockfiles", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-candidate-contracts-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = join(root, "service");
    const contracts = join(service, "plurnk-contracts");
    const client = join(root, "client");
    await Promise.all([mkdir(contracts, { recursive: true }), mkdir(join(service, "scripts"), { recursive: true }), mkdir(client)]);
    const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
    await json(join(service, "package.json"), { private: true, workspaces: ["plurnk-contracts"] });
    await json(join(contracts, "package.json"), { name: "@plurnk/plurnk-contracts", version: "1.0.0", type: "module", exports: "./index.js" });
    await writeFile(join(contracts, "index.js"), 'export const candidateContract = "selected revision";\n');
    await writeFile(join(service, "scripts/package-projection.mjs"), "export async function projectTarball() {}\n");
    const manifest = { private: true, type: "module", scripts: { build: "node build.mjs" }, dependencies: { "@plurnk/plurnk-contracts": "^1.0.0" } };
    await json(join(client, "package.json"), manifest);
    await json(join(client, "package-lock.json"), { name: "fixture", lockfileVersion: 3, packages: {} });
    await writeFile(join(client, "build.mjs"), 'import { candidateContract } from "@plurnk/plurnk-contracts"; import { writeFileSync } from "node:fs"; writeFileSync("built.txt", candidateContract);\n');
    const sources = await Promise.all(["package.json", "package-lock.json"].map((name) => readFile(join(client, name), "utf8")));
    await assert.rejects(execute("npm", ["run", "build"], { cwd: client }), /ERR_MODULE_NOT_FOUND/);
    await execute(process.execPath, [join(import.meta.dirname, "candidate-client.ts"), service, client]);
    assert.equal(await readFile(join(client, "built.txt"), "utf8"), "selected revision");
    assert.deepEqual(await Promise.all(["package.json", "package-lock.json"].map((name) => readFile(join(client, name), "utf8"))), sources);
});
}

// ─── candidate-isolation.test.ts ───
{
// {§benchlet-diagnostic}



test("{§benchlet-diagnostic} disables ambient endpoint and skill aliases without blanking definitions, and retains independent network ceilings", () => {
    const { overrides, masked, capabilities } = candidateIsolation([
        "PLURNK_MCP_brave_TOOLS", "PLURNK_MCP_EXPANDED", "PLURNK_MCP_CONNECT_TIMEOUT",
        "PLURNK_MCP_code_search", "PLURNK_MCP_code_search_ENABLED",
        "PLURNK_A2A_helper", "PLURNK_A2A_helper_ENABLED", "PLURNK_A2A_EXPOSE", "PLURNK_A2A_TOKEN", "PLURNK_A2A_NAME",
        "PLURNK_A2A_WORKSPACE", "PLURNK_A2A_PROPOSALS", "PLURNK_A2A_SKILLS",
        "PLURNK_MODEL_dumbox", "DEEPSEEK_API_KEY", "PLURNK_A2A_helper",
        "PLURNK_SKILLS_3d_tools", "PLURNK_SKILLS_分析", "PLURNK_SKILLS_分析_ENABLED", "PLURNK_SKILLS_ENABLED",
    ]);
    assert.deepEqual(masked, ["PLURNK_A2A_helper", "PLURNK_MCP_brave", "PLURNK_MCP_code_search", "PLURNK_SKILLS_3d_tools", "PLURNK_SKILLS_分析"]);
    assert.deepEqual(capabilities, { deny: [{ traits: ["web"] }, { operation: "mcp" }, { operation: "a2a" }] }, "the ceiling names the trait the web schemes declare and the two families it masks, never a host");
    assert.deepEqual(overrides, {
        PLURNK_MCP_ENABLED: "0", PLURNK_A2A_ENABLED: "0",
        PLURNK_A2A_helper_ENABLED: "0", PLURNK_MCP_brave_ENABLED: "0", PLURNK_MCP_code_search_ENABLED: "0",
        PLURNK_SKILLS_3d_tools_ENABLED: "0", PLURNK_SKILLS_分析_ENABLED: "0",
        BRAVE_API_KEY: "", TAVILY_API_KEY: "",
        PLURNK_SERVICE_CAPABILITIES: "{\"deny\":[{\"traits\":[\"web\"]},{\"operation\":\"mcp\"},{\"operation\":\"a2a\"}]}",
        PLURNK_SCHEMES_HTTP_HOSTS: "[]",
    });
});
}

// ─── client-checkout.test.ts ───
{
const root = resolve(import.meta.dirname, "..");

test("{§benchlet-diagnostic} client checkout paths are explicit and bench-root-relative", () => {
    for (const value of [undefined, "", "   "]) {
        assert.throws(
            () => requiredClientCheckout("/open/plurnk-bench", {
                ...(value === undefined ? {} : { CLIENT_ROOT: value }),
            }, "CLIENT_ROOT"),
            /CLIENT_ROOT must name an explicit outside-client checkout/,
        );
    }
    assert.equal(
        requiredClientCheckout("/open/plurnk-bench", { CLIENT_ROOT: " ../client " }, "CLIENT_ROOT"),
        "/open/client",
    );
    assert.equal(
        requiredClientCheckout("/open/plurnk-bench", { CLIENT_ROOT: "~/client" }, "CLIENT_ROOT"),
        resolve(homedir(), "client"),
    );
});

test("{§benchlet-diagnostic} portable defaults do not select a client checkout", () => {
    const defaults = readFileSync(resolve(root, ".env.defaults"), "utf8");
    for (const name of ["PLURNK_BENCHLET_CLIENT_ROOT", "PLURNK_BENCH_ATLAS_CLIENT_ROOT"]) {
        assert.doesNotMatch(defaults, new RegExp(`^${name}=`, "m"));
        assert.match(defaults, new RegExp(`^# ${name}=/path/to/open-client$`, "m"));
    }
});

test("{§benchlet-diagnostic} both benchlets reject a blank checkout before allocating a run", () => {
    for (const specimen of [
        {
            path: "deepswe/benchlet.ts",
            args: ["--preflight"],
            name: "PLURNK_BENCHLET_CLIENT_ROOT",
        },
        {
            path: "atlas/benchlet.ts",
            args: [],
            name: "PLURNK_BENCH_ATLAS_CLIENT_ROOT",
        },
    ]) {
        const result = spawnSync(process.execPath, [
            "--conditions=plurnk-dev",
            specimen.path,
            ...specimen.args,
        ], {
            cwd: root,
            encoding: "utf8",
            env: {
                ...process.env,
                [specimen.name]: "",
            },
        });
        assert.notEqual(result.status, 0, `${specimen.path} must reject the blank checkout`);
        assert.match(
            result.stderr,
            new RegExp(`${specimen.name} must name an explicit outside-client checkout`),
        );
        assert.doesNotMatch(result.stderr, /artifact=/, "failure precedes run allocation");
    }
});
}

// ─── npm-pack.test.ts ───
{
const contracts = { name: "@plurnk/plurnk-contracts", version: "1.0.0", filename: "plurnk-plurnk-contracts-1.0.0.tgz" };
const service = { name: "@plurnk/plurnk-service", version: "1.0.0", filename: "plurnk-plurnk-service-1.0.0.tgz" };

test("{§bench-relock} npm 11's pack array and npm 12's name-keyed envelope yield the same records", () => {
    const expected = [contracts, service];
    assert.deepEqual(packRecords(JSON.stringify([contracts, service])), expected, "npm 11: an array of records");
    assert.deepEqual(packRecords(JSON.stringify({ [contracts.name]: contracts, [service.name]: service })), expected, "npm 12: records keyed by package name");
    assert.deepEqual(packRecords(JSON.stringify([{ ...contracts, files: [], size: 1 }])), [contracts], "only the artifact identity is kept");
    assert.throws(() => packRecords("[]"), /no artifacts/, "nothing packed");
    assert.throws(() => packRecords("{}"), /no artifacts/, "nothing packed, keyed form");
    assert.throws(() => packRecords("null"), /no artifacts/, "no envelope");
    assert.throws(() => packRecords(JSON.stringify([{ name: contracts.name, version: "1.0.0" }])), /without a name, version or filename/, "a record without an archive name");
});

test("{§bench-relock} the candidate client takes exactly the contracts package from either envelope", () => {
    assert.deepEqual(packedContracts(JSON.stringify([contracts])), contracts);
    assert.deepEqual(packedContracts(JSON.stringify({ [contracts.name]: contracts })), contracts);
    const refused = /did not pack its contracts/;
    assert.throws(() => packedContracts("[]"), refused, "nothing packed");
    assert.throws(() => packedContracts(JSON.stringify([contracts, service])), refused, "more than the contracts");
    assert.throws(() => packedContracts(JSON.stringify({ [service.name]: service })), refused, "the wrong package");
    assert.throws(() => packedContracts(JSON.stringify([{ name: contracts.name, version: "1.0.0" }])), refused, "a record without an archive name");
});
}

// ─── web-materialization.test.ts ───
{
test("{§config-carry} absent Tavily configuration records the proprietary route as unavailable", () => {
    assert.deepEqual(webMaterializationProvenance({
        XAI_API_KEY: "model-secret",
    }), {
        tavily: { configured: false, depth: "basic" },
    });
});

test("{§config-carry} configured Tavily records presence and depth without the secret", () => {
    assert.deepEqual(webMaterializationProvenance({
        TAVILY_API_KEY: "paid-secret",
        PLURNK_SCHEMES_HTTP_TAVILY_DEPTH: "advanced",
    }), {
        tavily: { configured: true, depth: "advanced" },
    });
});

test("{§config-carry} malformed extraction depth fails before a run", () => {
    assert.throws(
        () => webMaterializationProvenance({
            PLURNK_SCHEMES_HTTP_TAVILY_DEPTH: "automatic",
        }),
        /PLURNK_SCHEMES_HTTP_TAVILY_DEPTH must be basic or advanced/,
    );
});
}
