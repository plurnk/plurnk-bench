// usage: node deepswe/pin-task.mjs <task>... — pins a cached DeepSWE task (.cache/deep-swe/tasks/<task>) as a
// docker-backed benchlet manifest: repository and base commit from the task's Dockerfile, the task image by
// its ext_id, and the sha256 of every task file the benchlet snapshots. Fails hard when anything is missing.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");
const IMAGE_REPOSITORY = "public.ecr.aws/d3j8x8q7/swe-bench-202605";
const IMAGE_VERSION = "v1.1";
const FILES = ["environment/Dockerfile", "instruction.md", "pre_artifacts.sh", "task.toml", "tests/config.json", "tests/Dockerfile", "tests/grader.py", "tests/test.patch", "tests/test.sh"];
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const pin = (task) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(task)) throw new Error(`invalid task name: ${task}`);
    const taskDir = resolve(benchRoot, ".cache", "deep-swe", "tasks", task);
    if (!existsSync(taskDir)) throw new Error(`task is not cached: ${taskDir}`);
    const dockerfile = readFileSync(resolve(taskDir, "environment", "Dockerfile"), "utf8");
    const repositoryUrl = dockerfile.match(/git clone (\S+) \./)?.[1];
    const pinnedSha = dockerfile.match(/BASE_SHA=([0-9a-f]{7,40})/)?.[1];
    if (!repositoryUrl || !pinnedSha) throw new Error(`${task}: the environment Dockerfile names no repository clone or BASE_SHA`);
    const extIdEarly = readFileSync(resolve(taskDir, "task.toml"), "utf8").match(/^ext_id = "([a-z0-9]+)"$/m)?.[1];
    if (!extIdEarly) throw new Error(`${task}: task.toml carries no ext_id`);
    // The full commit is what the image checked out; the Dockerfile may carry a prefix.
    const baseCommit = execFileSync("docker", ["run", "--rm", "--entrypoint", "git", `${IMAGE_REPOSITORY}:${extIdEarly}-${IMAGE_VERSION}`, "-C", "/app", "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (!/^[0-9a-f]{40}$/.test(baseCommit) || !baseCommit.startsWith(pinnedSha)) throw new Error(`${task}: the image's HEAD ${baseCommit} does not match the Dockerfile's BASE_SHA ${pinnedSha}`);
    const extId = readFileSync(resolve(taskDir, "task.toml"), "utf8").match(/^ext_id = "([a-z0-9]+)"$/m)?.[1];
    if (!extId) throw new Error(`${task}: task.toml carries no ext_id`);
    const image = `${IMAGE_REPOSITORY}:${extId}-${IMAGE_VERSION}`;
    execFileSync("docker", ["image", "inspect", image], { stdio: ["ignore", "ignore", "pipe"] });
    const files = Object.fromEntries(FILES.filter((name) => existsSync(resolve(taskDir, name))).map((name) => [name, sha256(resolve(taskDir, name))]));
    for (const required of ["environment/Dockerfile", "instruction.md", "task.toml", "tests/test.sh", "tests/grader.py"]) if (!(required in files)) throw new Error(`${task}: missing ${required}`);
    const manifest = {
        schemaVersion: 1,
        task,
        repositoryUrl,
        baseCommit,
        environment: { kind: "docker", image, network: "none", cpus: 4, memoryMb: 8192 },
        verifier: { kind: "task", timeoutSeconds: 1800 },
        files,
    };
    const out = resolve(moduleDir, "benchlet.manifests", `${task}.json`);
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`pinned ${task} → ${out} (${image}, ${baseCommit.slice(0, 12)}, ${Object.keys(files).length} files)`);
};

const tasks = process.argv.slice(2);
if (tasks.length === 0) throw new Error("usage: node deepswe/pin-task.mjs <task>...");
for (const task of tasks) pin(task);
