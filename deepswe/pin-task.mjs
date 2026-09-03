// usage: node deepswe/pin-task.mjs <task>... — pins a cached DeepSWE task (.cache/deep-swe/tasks/<task>) as a
// docker-backed benchlet manifest: repository and base commit from the task's Dockerfile, the task image by
// its ext_id, and the sha256 of every task file the benchlet snapshots. Fails hard when anything is missing.
//        node deepswe/pin-task.mjs --terminal-bench <task>... — pins a cached Terminal-Bench 2.1 task
// (.cache/terminal-bench-2-1/terminal-bench-2-1/<task>) as a tree manifest ({§benchlet-tree}): the image, budgets,
// and resources from task.toml, the sha256 of the instruction, task.toml, Dockerfile, and every tests/ file.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    // The image's checkout is the commit the task really ran on; the oracle's base_commit and the
    // Dockerfile's BASE_SHA are sometimes truncated upstream, so both are checked as prefixes of it.
    const baseCommit = execFileSync("docker", ["run", "--rm", "--entrypoint", "git", `${IMAGE_REPOSITORY}:${extIdEarly}-${IMAGE_VERSION}`, "-C", "/app", "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const oracleCommit = JSON.parse(readFileSync(resolve(taskDir, "tests", "config.json"), "utf8")).base_commit;
    if (!/^[0-9a-f]{40}$/.test(baseCommit)) throw new Error(`${task}: the image's HEAD is not a full commit: ${baseCommit}`);
    for (const [name, prefix] of [["Dockerfile BASE_SHA", pinnedSha], ["oracle base_commit", oracleCommit]]) {
        if (typeof prefix !== "string" || prefix.length < 7 || !baseCommit.startsWith(prefix)) throw new Error(`${task}: ${name} ${prefix} is not a prefix of the image's HEAD ${baseCommit}`);
    }
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

const TB_CACHE = ".cache/terminal-bench-2-1/terminal-bench-2-1";
// [section] key = value — the task.toml facts a tree manifest pins; no TOML dependency.
const tomlValue = (text, section, key) => {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trim() === `[${section}]`);
    if (start < 0) return null;
    for (const line of lines.slice(start + 1)) {
        if (/^\s*\[/.test(line)) break;
        const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`));
        if (match) return match[1].replace(/^"(.*)"$/, "$1");
    }
    return null;
};
const pinTree = (task) => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(task)) throw new Error(`invalid task name: ${task}`);
    const taskDir = resolve(benchRoot, TB_CACHE, task);
    if (!existsSync(taskDir)) throw new Error(`task is not cached: ${taskDir}`);
    const toml = readFileSync(resolve(taskDir, "task.toml"), "utf8");
    const image = tomlValue(toml, "environment", "docker_image");
    const budgetSeconds = Math.trunc(Number(tomlValue(toml, "agent", "timeout_sec")));
    const verifierSeconds = Math.trunc(Number(tomlValue(toml, "verifier", "timeout_sec")));
    const cpus = Number(tomlValue(toml, "environment", "cpus"));
    const memoryMb = Math.trunc(Number(tomlValue(toml, "environment", "memory_mb")));
    if (!image) throw new Error(`${task}: task.toml names no docker_image`);
    if (!(budgetSeconds > 0) || !(verifierSeconds > 0) || !(cpus > 0) || !(memoryMb > 0)) throw new Error(`${task}: task.toml budgets or resources are unreadable`);
    execFileSync("docker", ["image", "inspect", image], { stdio: ["ignore", "ignore", "pipe"] });
    const testsDir = resolve(taskDir, "tests");
    const testFiles = readdirSync(testsDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `tests/${resolve(entry.parentPath, entry.name).slice(testsDir.length + 1)}`);
    const names = ["instruction.md", "task.toml", "environment/Dockerfile", ...testFiles].filter((name) => existsSync(resolve(taskDir, name)));
    const files = Object.fromEntries(names.toSorted().map((name) => [name, sha256(resolve(taskDir, name))]));
    for (const required of ["instruction.md", "task.toml", "tests/test.sh"]) if (!(required in files)) throw new Error(`${task}: missing ${required}`);
    const manifest = {
        schemaVersion: 1,
        task,
        kind: "terminal-bench",
        taskCache: TB_CACHE,
        repositoryUrl: null,
        baseCommit: null,
        budgetSeconds,
        environment: { kind: "docker", image, network: "bridge", cpus, memoryMb },
        verifier: { kind: "tree", timeoutSeconds: verifierSeconds },
        files,
    };
    const out = resolve(moduleDir, "benchlet.manifests", `${task}.json`);
    writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`pinned ${task} → ${out} (${image}, budget ${budgetSeconds}s, ${Object.keys(files).length} files)`);
};
const args = process.argv.slice(2);
const tree = args[0] === "--terminal-bench";
const tasks = tree ? args.slice(1) : args;
if (tasks.length === 0) throw new Error("usage: node deepswe/pin-task.mjs [--terminal-bench] <task>...");
for (const task of tasks) (tree ? pinTree : pin)(task);
