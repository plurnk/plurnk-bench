import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    git,
    gitDir,
    removeContainer,
    runToFiles,
    sha256,
    shell,
    streamGitDiff,
    writeJson,
} from "../src/benchlet-runtime.ts";

export type TestStatus = "passed" | "skipped" | "failed";

export interface ManifestBase {
    schemaVersion: number;
    task: string;
    repositoryUrl: string;
    baseCommit: string;
    files: Record<string, string>;
}

export interface HostManifest extends ManifestBase {
    environment: {
        kind: "host";
    };
    verifier: {
        kind: "go";
        suites: Array<{
            name: string;
            package: string;
            buckets: Array<"p2p" | "f2p">;
            timeoutSeconds: number;
        }>;
    };
}

export interface DockerManifest extends ManifestBase {
    environment: {
        kind: "docker";
        image: string;
        network: "none";
        cpus: number;
        memoryMb: number;
    };
    verifier: {
        kind: "task";
        timeoutSeconds: number;
    };
}

// A Terminal-Bench 2.1 task ({§benchlet-diagnostic}): no repository — the image's /app IS the task tree —
// and a verifier that grades that tree (tests/test.sh → /logs/verifier/reward.txt + ctrf.json).
export interface TreeManifest {
    schemaVersion: number;
    task: string;
    kind: "terminal-bench";
    taskCache: string;
    repositoryUrl: null;
    baseCommit: null;
    budgetSeconds: number;
    environment: {
        kind: "docker";
        image: string;
        network: "bridge";
        cpus: number;
        memoryMb: number;
    };
    verifier: {
        kind: "tree";
        timeoutSeconds: number;
    };
    files: Record<string, string>;
}

export type Manifest = HostManifest | DockerManifest | TreeManifest;

export const isDockerManifest = (manifest: Manifest): manifest is DockerManifest =>
    manifest.environment.kind === "docker" && manifest.verifier.kind === "task";

export const isHostManifest = (manifest: Manifest): manifest is HostManifest =>
    manifest.environment.kind === "host" && manifest.verifier.kind === "go";

export const isTreeManifest = (manifest: Manifest): manifest is TreeManifest =>
    manifest.verifier.kind === "tree";

export interface CtrfReport {
    results?: {
        tests?: Array<{
            name: string;
            status: string;
            message?: string;
            trace?: string;
        }>;
    };
}

export interface VerifierReward {
    reward: number;
    apply_failed?: number;
    p2p_passed: number;
    p2p_total: number;
    f2p_passed: number;
    f2p_total: number;
    partial: number;
}

export interface OracleConfig {
    base_commit: string;
    p2p_node_ids: string[];
    f2p_node_ids: string[];
}

export interface TestObservation {
    status: TestStatus;
    output: string;
}

export interface OracleResult {
    applyFailed: boolean;
    reward: 0 | 1;
    p2pPassed: number;
    p2pTotal: number;
    f2pPassed: number;
    f2pTotal: number;
    partial: number;
    tests: Array<{
        nodeId: string;
        bucket: "p2p" | "f2p";
        status: TestStatus;
        output: string;
    }>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");

const statusRank: Record<TestStatus, number> = {
    passed: 0,
    skipped: 1,
    failed: 2,
};

export const parseGoTestEvents = (text: string): Map<string, TestObservation> => {
    const observations = new Map<string, TestObservation>();
    const output = new Map<string, string[]>();
    const running = new Set<string>();
    for (const [index, line] of text.split("\n").entries()) {
        if (line.trim() === "") continue;
        let event: { Action?: string; Package?: string; Test?: string; Output?: string };
        try {
            event = JSON.parse(line) as typeof event;
        } catch (error) {
            throw new Error(`go test -json emitted malformed JSON on line ${index + 1}`, { cause: error });
        }
        if (event.Package === undefined || event.Test === undefined) continue;
        const nodeId = `${event.Package}.${event.Test}`;
        if (event.Action === "run") running.add(nodeId);
        if (event.Output !== undefined) {
            const lines = output.get(nodeId) ?? [];
            lines.push(event.Output);
            output.set(nodeId, lines);
        }
        const status = event.Action === "pass"
            ? "passed"
            : event.Action === "skip"
                ? "skipped"
                : event.Action === "fail"
                    ? "failed"
                    : undefined;
        if (status === undefined) continue;
        const current = observations.get(nodeId);
        if (current === undefined || statusRank[status] >= statusRank[current.status]) {
            observations.set(nodeId, {
                status,
                output: (output.get(nodeId) ?? []).join("").trim(),
            });
        }
        running.delete(nodeId);
    }
    for (const nodeId of running) {
        const captured = (output.get(nodeId) ?? []).join("").trim();
        observations.set(nodeId, {
            status: "failed",
            output: [
                captured,
                "go test ended after starting this test without emitting a terminal event",
            ].filter(Boolean).join("\n"),
        });
    }
    return observations;
};

// {§benchlet-diagnostic}
export const environmentExcludedP2p = (baseline: OracleResult): OracleResult["tests"] =>
    baseline.tests.filter((test) => test.bucket === "p2p" && test.status !== "passed");

export const baselineInvalidity = (baseline: OracleResult): string | null => {
    if (baseline.f2pPassed !== 0) {
        return `external oracle baseline is invalid: p2p ${baseline.p2pPassed}/${baseline.p2pTotal}, f2p ${baseline.f2pPassed}/${baseline.f2pTotal}`;
    }
    const excluded = environmentExcludedP2p(baseline).length;
    if (excluded > Math.max(1, Math.floor(baseline.p2pTotal / 10))) {
        return `external oracle baseline is invalid: p2p ${baseline.p2pPassed}/${baseline.p2pTotal} (more than a tenth fail before any model runs), f2p ${baseline.f2pPassed}/${baseline.f2pTotal}`;
    }
    return null;
};

export const withoutExcluded = (config: OracleConfig, excluded: ReadonlyArray<{ nodeId: string }>): OracleConfig => {
    const drop = new Set(excluded.map(({ nodeId }) => nodeId));
    return { ...config, p2p_node_ids: config.p2p_node_ids.filter((nodeId) => !drop.has(nodeId)) };
};

export const gradeObservations = (
    config: OracleConfig,
    observations: Map<string, TestObservation>,
    applyFailed = false,
): OracleResult => {
    const tests = [
        ...config.p2p_node_ids.map((nodeId) => ({ nodeId, bucket: "p2p" as const })),
        ...config.f2p_node_ids.map((nodeId) => ({ nodeId, bucket: "f2p" as const })),
    ].map(({ nodeId, bucket }) => {
        const observed = applyFailed ? undefined : observations.get(nodeId);
        return {
            nodeId,
            bucket,
            status: observed?.status ?? "failed" as TestStatus,
            output: observed?.output ?? (applyFailed ? "submission patch did not apply" : "test absent from oracle output"),
        };
    });
    const p2pPassed = tests.filter((test) => test.bucket === "p2p" && test.status === "passed").length;
    const f2pPassed = tests.filter((test) => test.bucket === "f2p" && test.status === "passed").length;
    const p2pTotal = config.p2p_node_ids.length;
    const f2pTotal = config.f2p_node_ids.length;
    const passed = p2pPassed + f2pPassed;
    const total = p2pTotal + f2pTotal;
    return {
        applyFailed,
        reward: f2pTotal > 0 && p2pPassed === p2pTotal && f2pPassed === f2pTotal ? 1 : 0,
        p2pPassed,
        p2pTotal,
        f2pPassed,
        f2pTotal,
        partial: total === 0 ? 0 : passed / total,
        tests,
    };
};

const verifyFixtureFiles = (manifest: Manifest, taskDir: string): void => {
    for (const [name, expected] of Object.entries(manifest.files)) {
        const path = resolve(taskDir, name);
        if (!existsSync(path)) throw new Error(`external task fixture is missing ${name}: ${path}`);
        const actual = sha256(path);
        if (actual !== expected) {
            throw new Error(`external task fixture drifted at ${name}: expected ${expected}, received ${actual}`);
        }
    }
};

export const validateFixture = (manifest: Manifest, taskDir: string): OracleConfig => {
    assert.equal(manifest.schemaVersion, 1, "benchlet manifest schema must be version 1");
    if (isTreeManifest(manifest)) {
        assert.equal(manifest.kind, "terminal-bench", "tree manifest must be a terminal-bench task");
        assert.ok(manifest.taskCache !== "", "tree manifest must name its task cache");
        assert.ok(Number.isSafeInteger(manifest.budgetSeconds) && manifest.budgetSeconds > 0, "tree manifest must pin the task's agent budget");
        assert.ok(manifest.environment.image !== "", "Docker environment must pin an image");
        assert.ok(Number.isFinite(manifest.environment.cpus) && manifest.environment.cpus > 0);
        assert.ok(Number.isSafeInteger(manifest.environment.memoryMb) && manifest.environment.memoryMb > 0);
        assert.ok(Number.isSafeInteger(manifest.verifier.timeoutSeconds) && manifest.verifier.timeoutSeconds > 0);
        verifyFixtureFiles(manifest, taskDir);
        for (const required of ["instruction.md", "task.toml", "tests/test.sh"]) {
            if (!(required in manifest.files)) throw new Error(`tree manifest must pin ${required}`);
        }
        return { base_commit: "", p2p_node_ids: [], f2p_node_ids: [] };
    }
    assert.ok(manifest.repositoryUrl !== "", "benchlet manifest must pin a repository URL");
    assert.match(manifest.baseCommit, /^[0-9a-f]{40}$/, "benchlet manifest must pin a full Git commit");
    verifyFixtureFiles(manifest, taskDir);
    const config = JSON.parse(readFileSync(resolve(taskDir, "tests/config.json"), "utf8")) as OracleConfig;
    assert.ok(
        typeof config.base_commit === "string" && config.base_commit.length >= 7 && manifest.baseCommit.startsWith(config.base_commit),
        `oracle base commit ${JSON.stringify(config.base_commit)} must be a prefix of the pinned commit ${manifest.baseCommit}`,
    );
    if (manifest.verifier.kind === "task") {
        assert.equal(manifest.environment.kind, "docker", "task verifier requires its pinned Docker environment");
        assert.ok(manifest.environment.image !== "", "Docker environment must pin an image");
        assert.ok(Number.isFinite(manifest.environment.cpus) && manifest.environment.cpus > 0);
        assert.ok(Number.isSafeInteger(manifest.environment.memoryMb) && manifest.environment.memoryMb > 0);
        assert.ok(Number.isSafeInteger(manifest.verifier.timeoutSeconds) && manifest.verifier.timeoutSeconds > 0);
        return config;
    }

    const configured = new Set([...config.p2p_node_ids, ...config.f2p_node_ids]);
    const selected = new Map<string, number>();
    for (const suite of manifest.verifier.suites) {
        if (!Number.isSafeInteger(suite.timeoutSeconds) || suite.timeoutSeconds <= 0) {
            throw new Error(`suite ${suite.name} must declare a positive timeoutSeconds`);
        }
        for (const bucket of suite.buckets) {
            const ids = bucket === "p2p" ? config.p2p_node_ids : config.f2p_node_ids;
            for (const nodeId of ids) {
                if (nodeId.startsWith(`${suite.package}.`)) {
                    selected.set(nodeId, (selected.get(nodeId) ?? 0) + 1);
                }
            }
        }
    }
    assert.deepEqual([...selected.keys()].toSorted(), [...configured].toSorted(), "suite selectors must cover every oracle node");
    assert.ok([...selected.values()].every((count) => count === 1), "suite selectors must cover every oracle node exactly once");
    return config;
};

export const ensureRepositoryCache = (manifest: HostManifest, cache: string): void => {
    if (!existsSync(cache)) {
        mkdirSync(dirname(cache), { recursive: true });
        shell("git", ["init", "--bare", "--quiet", cache]);
        gitDir(cache, ["remote", "add", "origin", manifest.repositoryUrl]);
    }
    assert.equal(gitDir(cache, ["rev-parse", "--is-bare-repository"]).trim(), "true");
    assert.equal(gitDir(cache, ["remote", "get-url", "origin"]).trim(), manifest.repositoryUrl);
    gitDir(cache, ["fetch", "--quiet", "--depth=1", "origin", manifest.baseCommit]);
    const fetched = gitDir(cache, ["rev-parse", "FETCH_HEAD"]).trim();
    assert.equal(fetched, manifest.baseCommit, "repository fetch returned the pinned base commit");
    gitDir(cache, ["update-ref", "refs/heads/benchlet-base", manifest.baseCommit]);
};

// {§benchlet-diagnostic} — the container path every Terminal-Bench instruction names for its tree.
export const TREE_TASK_ROOT = "/app";
export const treeInstruction = (instruction: string, root: string): string =>
    instruction.replaceAll(new RegExp(`${TREE_TASK_ROOT}(?=/|\\b)`, "g"), root);

export const snapshotTask = (
    runDir: string,
    manifestPath: string,
    manifest: Manifest,
    taskDir: string,
): void => {
    const destination = resolve(runDir, "task");
    mkdirSync(destination, { recursive: true });
    copyFileSync(manifestPath, resolve(destination, "benchlet.manifest.json"));
    for (const name of Object.keys(manifest.files)) {
        const target = resolve(destination, name);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(resolve(taskDir, name), target);
    }
};

export const cloneBase = (cache: string, destination: string, baseCommit: string): void => {
    shell("git", ["clone", "--quiet", "--no-checkout", cache, destination]);
    git(destination, ["checkout", "--quiet", "-B", "main", baseCommit]);
    git(destination, ["config", "core.hooksPath", "/dev/null"]);
    git(destination, ["config", "user.name", "Plurnk"]);
    git(destination, ["config", "user.email", "plurnk@pm.me"]);
};

const copyDockerBase = (manifest: DockerManifest, destination: string): void => {
    mkdirSync(destination, { recursive: true });
    const container = shell("docker", ["create", manifest.environment.image]).trim();
    try {
        shell("docker", ["cp", `${container}:/app/.`, destination]);
    } finally {
        removeContainer(container);
    }
    assert.equal(git(destination, ["rev-parse", "HEAD"]).trim(), manifest.baseCommit);
    assert.equal(git(destination, ["status", "--porcelain"]), "", "Docker task checkout must be pristine");
    git(destination, ["config", "core.hooksPath", "/dev/null"]);
    git(destination, ["config", "user.name", "Plurnk"]);
    git(destination, ["config", "user.email", "plurnk@pm.me"]);
};

const copyDockerTree = (image: string, destination: string): void => {
    mkdirSync(destination, { recursive: true });
    const container = shell("docker", ["create", image]).trim();
    try {
        shell("docker", ["cp", `${container}:/app/.`, destination]);
    } finally {
        removeContainer(container);
    }
};

export const prepareCandidateRepository = (
    manifest: Manifest,
    repositoryCache: string,
    destination: string,
): void => {
    if (isTreeManifest(manifest)) {
        copyDockerTree(manifest.environment.image, destination);
        return;
    }
    if (isDockerManifest(manifest)) {
        copyDockerBase(manifest, destination);
        return;
    }
    assert.ok(isHostManifest(manifest), "benchlet manifest environment and verifier are incompatible");
    cloneBase(repositoryCache, destination, manifest.baseCommit);
};

export const capturePatches = async (
    repository: string,
    runDir: string,
    baseCommit: string,
    prefix = "",
    signal?: AbortSignal,
): Promise<{
    branch: string;
    head: string;
    status: string;
    committed: boolean;
    submissionSha256: string;
    workingSha256: string;
}> => {
    signal?.throwIfAborted();
    const status = git(repository, ["status", "--porcelain=v2", "--branch"]);
    const branch = git(repository, ["branch", "--show-current"]).trim();
    const head = git(repository, ["rev-parse", "HEAD"]).trim();
    const submissionPath = resolve(runDir, `${prefix}model.patch`);
    await streamGitDiff(repository, ["diff", "--binary", baseCommit, "HEAD", "--"], submissionPath, process.env, signal);

    const alternateIndex = resolve(runDir, `${prefix}working-tree.index`);
    const indexEnv = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    git(repository, ["read-tree", "HEAD"], { env: indexEnv });
    git(repository, ["add", "-A"], { env: indexEnv });
    const workingPath = resolve(runDir, `${prefix}working.patch`);
    await streamGitDiff(repository, ["diff", "--cached", "--binary", baseCommit, "--"], workingPath, indexEnv, signal);
    rmSync(alternateIndex, { force: true });

    return {
        branch,
        head,
        status,
        committed: head !== baseCommit,
        submissionSha256: sha256(submissionPath),
        workingSha256: sha256(workingPath),
    };
};

// {§benchlet-diagnostic}
export const captureTree = (
    tree: string,
    runDir: string,
    prefix = "",
): {
    branch: string;
    head: string;
    status: string;
    committed: boolean;
    submissionSha256: string;
    workingSha256: string;
} => {
    const files = readdirSync(tree, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(tree, resolve(entry.parentPath, entry.name)))
        .toSorted();
    const listing = files.map((path) => ({ path, sha256: sha256(resolve(tree, path)) }));
    writeJson(resolve(runDir, `${prefix}working-tree.json`), { tree: relative(runDir, tree), files: listing });
    const digest = createHash("sha256")
        .update(listing.map(({ path, sha256: hash }) => `${hash}  ${path}\n`).join(""))
        .digest("hex");
    return { branch: "", head: "", status: "", committed: false, submissionSha256: digest, workingSha256: digest };
};

const regexEscape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const gradeGoPatch = async (
    label: string,
    patchPath: string,
    artifactDir: string,
    repositoryCache: string,
    manifest: HostManifest,
    taskDir: string,
    config: OracleConfig,
    signal?: AbortSignal,
): Promise<OracleResult> => {
    signal?.throwIfAborted();
    mkdirSync(artifactDir, { recursive: true });
    const workRoot = mkdtempSync(resolve(tmpdir(), `plurnk-benchlet-${label}-`));
    const repository = resolve(workRoot, "repo");
    try {
        cloneBase(repositoryCache, repository, manifest.baseCommit);
        const observations = new Map<string, TestObservation>();
        const prepareDir = resolve(artifactDir, "prepare");
        const modelArtifacts = resolve(prepareDir, "artifacts");
        const verifierArtifacts = resolve(prepareDir, "verifier");
        mkdirSync(modelArtifacts, { recursive: true });
        copyFileSync(patchPath, resolve(modelArtifacts, "model.patch"));
        const prepared = spawnSync("python3", [resolve(taskDir, "tests/grader.py"), "prepare"], {
            cwd: repository,
            env: {
                ...process.env,
                APP_DIR: repository,
                ARTIFACTS_DIR: modelArtifacts,
                TESTS_DIR: resolve(taskDir, "tests"),
                VERIFIER_DIR: verifierArtifacts,
            },
            encoding: "utf8",
        });
        writeFileSync(resolve(prepareDir, "stdout.log"), prepared.stdout);
        writeFileSync(resolve(prepareDir, "stderr.log"), prepared.stderr);
        writeJson(resolve(prepareDir, "command.json"), {
            command: "python3",
            args: [resolve(taskDir, "tests/grader.py"), "prepare"],
            status: prepared.status,
            signal: prepared.signal,
            error: prepared.error?.message ?? null,
        });
        if (prepared.error !== undefined) throw prepared.error;
        if (prepared.status !== 0) {
            throw new Error(`external verifier preparation failed for ${label}`);
        }
        const preparedRewardPath = resolve(verifierArtifacts, "reward.json");
        if (existsSync(preparedRewardPath)) {
            const preparedReward = JSON.parse(readFileSync(preparedRewardPath, "utf8")) as {
                apply_failed?: number;
            };
            if (preparedReward.apply_failed === 1) {
                return gradeObservations(config, observations, true);
            }
            throw new Error(`external verifier unexpectedly graded ${label} during preparation`);
        }

        for (const suite of manifest.verifier.suites) {
            const selected = suite.buckets.flatMap((bucket) =>
                (bucket === "p2p" ? config.p2p_node_ids : config.f2p_node_ids)
                    .filter((nodeId) => nodeId.startsWith(`${suite.package}.`)));
            const names = selected.map((nodeId) => nodeId.slice(suite.package.length + 1));
            const packagePath = `./${suite.package.split("/").at(-1)}`;
            const stdoutPath = resolve(artifactDir, `${suite.name}.jsonl`);
            const stderrPath = resolve(artifactDir, `${suite.name}.stderr.log`);
            const result = await runToFiles("go", [
                "test",
                "-json",
                "-count=1",
                `-timeout=${suite.timeoutSeconds}s`,
                packagePath,
                "-run",
                `^(${names.map(regexEscape).join("|")})$`,
            ], {
                cwd: repository,
                env: {
                    ...process.env,
                    GOCACHE: resolve(workRoot, ".gocache"),
                },
                stdoutPath,
                stderrPath,
                signal,
            });
            writeJson(resolve(artifactDir, `${suite.name}.command.json`), {
                command: "go",
                args: [
                    "test",
                    "-json",
                    "-count=1",
                    `-timeout=${suite.timeoutSeconds}s`,
                    packagePath,
                    "-run",
                    `^(${names.map(regexEscape).join("|")})$`,
                ],
                status: result.status,
                signal: result.signal,
                error: result.error?.message ?? null,
                timedOut: result.timedOut,
            });
            if (result.error !== undefined) throw result.error;
            if (result.signal !== null) {
                throw new Error(`oracle suite ${suite.name} was terminated by ${result.signal}`);
            }
            const parsed = parseGoTestEvents(readFileSync(stdoutPath, "utf8"));
            for (const [nodeId, observation] of parsed) {
                const current = observations.get(nodeId);
                if (current === undefined || statusRank[observation.status] >= statusRank[current.status]) {
                    observations.set(nodeId, observation);
                }
            }
        }
        return gradeObservations(config, observations);
    } finally {
        rmSync(workRoot, { recursive: true, force: true });
    }
};

export const parseTaskVerifierArtifacts = (
    config: OracleConfig,
    reward: VerifierReward,
    ctrf?: CtrfReport,
): OracleResult => {
    const applyFailed = reward.apply_failed === 1;
    if (applyFailed) {
        assert.equal(reward.reward, 0, "an unapplied patch cannot receive reward");
        return gradeObservations(config, new Map(), true);
    }
    if (ctrf === undefined) throw new Error("task verifier did not produce ctrf.json");

    const observations = new Map<string, TestObservation>();
    const tests = ctrf.results?.tests;
    if (!Array.isArray(tests)) throw new Error("task verifier emitted malformed CTRF test results");
    for (const test of tests) {
        const match = /^\[(p2p|f2p)\] (.+)$/.exec(test.name);
        if (match === null) throw new Error(`task verifier emitted an unbucketed test: ${test.name}`);
        const status = test.status === "passed" || test.status === "skipped" || test.status === "failed"
            ? test.status
            : "failed";
        const nodeId = match[2]!;
        if (observations.has(nodeId)) throw new Error(`task verifier emitted duplicate test evidence: ${nodeId}`);
        observations.set(nodeId, {
            status,
            output: test.message ?? test.trace ?? "",
        });
    }

    const result = gradeObservations(config, observations);
    assert.equal(result.p2pPassed, reward.p2p_passed, "CTRF and reward disagree on p2p passes");
    assert.equal(result.p2pTotal, reward.p2p_total, "manifest and reward disagree on p2p total");
    assert.equal(result.f2pPassed, reward.f2p_passed, "CTRF and reward disagree on f2p passes");
    assert.equal(result.f2pTotal, reward.f2p_total, "manifest and reward disagree on f2p total");
    assert.equal(result.reward, reward.reward, "CTRF and reward disagree on binary reward");
    assert.ok(Math.abs(result.partial - reward.partial) < Number.EPSILON, "CTRF and reward disagree on partial score");
    return result;
};

const gradeTaskPatch = async (
    label: string,
    patchPath: string,
    artifactDir: string,
    manifest: DockerManifest,
    taskDir: string,
    config: OracleConfig,
    signal?: AbortSignal,
): Promise<OracleResult> => {
    signal?.throwIfAborted();
    mkdirSync(artifactDir, { recursive: true });
    const verifierArtifacts = resolve(artifactDir, "verifier");
    mkdirSync(verifierArtifacts);
    const container = shell("docker", [
        "create",
        "--network",
        manifest.environment.network,
        "--cpus",
        String(manifest.environment.cpus),
        "--memory",
        `${manifest.environment.memoryMb}m`,
        manifest.environment.image,
        "sleep",
        "infinity",
    ]).trim();
    try {
        shell("docker", ["start", container]);
        shell("docker", ["exec", container, "mkdir", "-p", "/tests", "/logs/artifacts", "/logs/verifier"]);
        shell("docker", ["cp", `${resolve(taskDir, "tests")}/.`, `${container}:/tests`]);
        const pinned = JSON.parse(readFileSync(resolve(taskDir, "tests", "config.json"), "utf8")) as Record<string, unknown>;
        const pinnedP2p = pinned.p2p_node_ids;
        if (!Array.isArray(pinnedP2p)) throw new Error("pinned tests/config.json carries no p2p_node_ids array");
        if (pinnedP2p.length !== config.p2p_node_ids.length) {
            const overlay = resolve(artifactDir, "config.json");
            writeJson(overlay, { ...pinned, p2p_node_ids: config.p2p_node_ids });
            shell("docker", ["cp", overlay, `${container}:/tests/config.json`]);
        }
        shell("docker", ["cp", patchPath, `${container}:/logs/artifacts/model.patch`]);
        const args = ["exec", container, "bash", "/tests/test.sh"];
        const result = await runToFiles("docker", args, {
            cwd: benchRoot,
            stdoutPath: resolve(artifactDir, "stdout.log"),
            stderrPath: resolve(artifactDir, "stderr.log"),
            timeoutMs: manifest.verifier.timeoutSeconds * 1_000,
            signal,
        });
        writeJson(resolve(artifactDir, "command.json"), {
            command: "docker",
            args,
            status: result.status,
            signal: result.signal,
            error: result.error?.message ?? null,
            timedOut: result.timedOut,
        });
        shell("docker", ["cp", `${container}:/logs/verifier/.`, verifierArtifacts]);
        if (result.error !== undefined) throw result.error;
        if (result.timedOut) throw new Error(`task verifier timed out for ${label}`);
        if (result.status !== 0) {
            throw new Error(`task verifier failed for ${label} (${result.status ?? result.signal ?? "unknown"})`);
        }
        const rewardPath = resolve(verifierArtifacts, "reward.json");
        if (!existsSync(rewardPath)) throw new Error(`task verifier did not grade ${label}`);
        const reward = JSON.parse(readFileSync(rewardPath, "utf8")) as VerifierReward;
        const ctrfPath = resolve(verifierArtifacts, "ctrf.json");
        const ctrf = existsSync(ctrfPath)
            ? JSON.parse(readFileSync(ctrfPath, "utf8")) as CtrfReport
            : undefined;
        return parseTaskVerifierArtifacts(config, reward, ctrf);
    } finally {
        removeContainer(container);
    }
};

// {§benchlet-diagnostic}
export const parseTreeVerifierArtifacts = (rewardText: string, ctrf?: CtrfReport): OracleResult => {
    const reward = Number(rewardText.trim());
    if (reward !== 0 && reward !== 1) throw new Error(`tree verifier wrote an unreadable reward: ${JSON.stringify(rewardText)}`);
    const tests = ctrf === undefined ? [] : ctrf.results?.tests;
    if (!Array.isArray(tests)) throw new Error("tree verifier emitted malformed CTRF test results");
    const observed = tests.map((test) => ({
        nodeId: test.name,
        bucket: "f2p" as const,
        status: (test.status === "passed" || test.status === "skipped" || test.status === "failed" ? test.status : "failed") as TestStatus,
        output: test.message ?? test.trace ?? "",
    }));
    const f2pPassed = observed.filter((test) => test.status === "passed").length;
    if (ctrf !== undefined && (reward === 1) !== (observed.length > 0 && f2pPassed === observed.length)) {
        throw new Error(`tree verifier reward ${reward} disagrees with its CTRF evidence (${f2pPassed}/${observed.length} passed)`);
    }
    return {
        applyFailed: false,
        reward,
        p2pPassed: 0,
        p2pTotal: 0,
        f2pPassed,
        f2pTotal: observed.length,
        partial: observed.length === 0 ? reward : f2pPassed / observed.length,
        tests: observed,
    };
};

const gradeTaskTree = async (
    label: string,
    tree: string | null,
    artifactDir: string,
    manifest: TreeManifest,
    taskDir: string,
    signal?: AbortSignal,
): Promise<OracleResult> => {
    signal?.throwIfAborted();
    mkdirSync(artifactDir, { recursive: true });
    const verifierArtifacts = resolve(artifactDir, "verifier");
    mkdirSync(verifierArtifacts);
    const container = shell("docker", [
        "create",
        "--network",
        manifest.environment.network,
        "--cpus",
        String(manifest.environment.cpus),
        "--memory",
        `${manifest.environment.memoryMb}m`,
        manifest.environment.image,
        "sleep",
        "infinity",
    ]).trim();
    try {
        shell("docker", ["start", container]);
        shell("docker", ["exec", container, "mkdir", "-p", "/tests", "/logs/verifier"]);
        shell("docker", ["cp", `${resolve(taskDir, "tests")}/.`, `${container}:/tests`]);
        if (tree !== null) {
            shell("docker", ["exec", container, "sh", "-c", "find /app -mindepth 1 -delete"]);
            shell("docker", ["cp", `${tree}/.`, `${container}:/app`]);
        }
        const args = ["exec", container, "bash", "/tests/test.sh"];
        const result = await runToFiles("docker", args, {
            cwd: benchRoot,
            stdoutPath: resolve(artifactDir, "stdout.log"),
            stderrPath: resolve(artifactDir, "stderr.log"),
            timeoutMs: manifest.verifier.timeoutSeconds * 1_000,
            signal,
        });
        writeJson(resolve(artifactDir, "command.json"), {
            command: "docker",
            args,
            status: result.status,
            signal: result.signal,
            error: result.error?.message ?? null,
            timedOut: result.timedOut,
        });
        shell("docker", ["cp", `${container}:/logs/verifier/.`, verifierArtifacts]);
        if (result.error !== undefined) throw result.error;
        if (result.timedOut) throw new Error(`task verifier timed out for ${label}`);
        const rewardPath = resolve(verifierArtifacts, "reward.txt");
        if (!existsSync(rewardPath)) throw new Error(`task verifier did not grade ${label}`);
        const ctrfPath = resolve(verifierArtifacts, "ctrf.json");
        return parseTreeVerifierArtifacts(
            readFileSync(rewardPath, "utf8"),
            existsSync(ctrfPath) ? JSON.parse(readFileSync(ctrfPath, "utf8")) as CtrfReport : undefined,
        );
    } finally {
        removeContainer(container);
    }
};

export const gradePatch = (
    label: string,
    patchPath: string,
    artifactDir: string,
    repositoryCache: string,
    manifest: Manifest,
    taskDir: string,
    config: OracleConfig,
    tree: string | null = null,
    signal?: AbortSignal,
): Promise<OracleResult> => isTreeManifest(manifest)
    ? gradeTaskTree(label, tree, artifactDir, manifest, taskDir, signal)
    : isDockerManifest(manifest)
    ? gradeTaskPatch(label, patchPath, artifactDir, manifest, taskDir, config, signal)
    : isHostManifest(manifest)
        ? gradeGoPatch(label, patchPath, artifactDir, repositoryCache, manifest, taskDir, config, signal)
        : Promise.reject(new Error("benchlet manifest environment and verifier are incompatible"));
