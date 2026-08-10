import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    closeSync,
    copyFileSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { allocateRunDirectory } from "../src/run-directory.ts";
import { requiredClientCheckout } from "../src/client-checkout.ts";
import { webMaterializationProvenance } from "../src/web-materialization.ts";
import {
    addSettledUsd,
    summarizeDigestAccounting,
    summarizeRequiemAccounting,
    type RequiemAccountingInput,
} from "../src/accounting.ts";

type TestStatus = "passed" | "skipped" | "failed";

interface ManifestBase {
    schemaVersion: number;
    task: string;
    repositoryUrl: string;
    baseCommit: string;
    files: Record<string, string>;
}

interface HostManifest extends ManifestBase {
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

interface DockerManifest extends ManifestBase {
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

type Manifest = HostManifest | DockerManifest;

const isDockerManifest = (manifest: Manifest): manifest is DockerManifest =>
    manifest.environment.kind === "docker" && manifest.verifier.kind === "task";

const isHostManifest = (manifest: Manifest): manifest is HostManifest =>
    manifest.environment.kind === "host" && manifest.verifier.kind === "go";

interface CtrfReport {
    results?: {
        tests?: Array<{
            name: string;
            status: string;
            message?: string;
            trace?: string;
        }>;
    };
}

interface VerifierReward {
    reward: number;
    apply_failed?: number;
    p2p_passed: number;
    p2p_total: number;
    f2p_passed: number;
    f2p_total: number;
    partial: number;
}

interface OracleConfig {
    base_commit: string;
    p2p_node_ids: string[];
    f2p_node_ids: string[];
}

interface TestObservation {
    status: TestStatus;
    output: string;
}

interface CommandResult {
    status: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    error?: Error;
}

interface OracleResult {
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

interface DigestJson {
    workspaces: Array<{
        cost_usd: number | null;
    }>;
    workers: Array<{
        id: number;
        name: string;
    }>;
    loops: Array<{
        id: number;
        worker_id: number;
        sequence: number;
        status: number;
        terminated_by: string | null;
        result: {
            status: number;
            content?: string;
            problem?: Record<string, unknown> | null;
        } | null;
    }>;
    turns: Array<{
        id: number;
        model: string | null;
        usage_prompt: number;
        usage_completion: number;
        usage_cached: number;
        usage_cost_usd: number | null;
    }>;
    turn_attempts: Array<{
        accepted: boolean | null;
        usage_prompt: number | null;
        usage_completion: number | null;
        usage_reasoning: number | null;
        usage_cached: number | null;
        model: string;
    }>;
    log_entries: Array<{
        origin: string;
        op: string | null;
        status_rx: number;
        problem?: { type?: string } | null;
    }>;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");
let activeRunDir: string | undefined;
let activeStartedAt: Date | undefined;
let activeStage = "preflight";

const expandHome = (value: string): string =>
    value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;

const resolveFrom = (root: string, value: string): string => {
    const expanded = expandHome(value);
    return resolve(root, expanded);
};

export const manifestPathForTask = (task: string): string => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(task)) {
        throw new Error(`invalid benchlet task name: ${task}`);
    }
    return resolve(moduleDir, "benchlet.manifests", `${task}.json`);
};

export const candidatePolicyPath = (serviceRoot: string): string =>
    resolve(serviceRoot, "plurnk-meta", "PLURNK_PERSONALITY.md");

export const candidatePolicySnapshotPath = (runDir: string): string =>
    resolve(runDir, "candidate-policy.md");

const sha256 = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

const shell = (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): string => {
    const result = spawnSync(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: "utf8",
    });
    if (result.error !== undefined) throw result.error;
    if (!options.allowFailure && result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"}): `
            + `${result.stderr || result.stdout}`.trim(),
        );
    }
    return result.stdout;
};

const git = (repository: string, args: string[], options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): string =>
    shell("git", ["-C", repository, ...args], options);

const gitDir = (repository: string, args: string[]): string =>
    shell("git", [`--git-dir=${repository}`, ...args]);

const dockerImageId = (image: string): string => {
    const inspect = spawnSync("docker", ["image", "inspect", "--format={{.Id}}", image], {
        encoding: "utf8",
    });
    if (inspect.error !== undefined) throw inspect.error;
    if (inspect.status !== 0) {
        shell("docker", ["pull", image]);
        return shell("docker", ["image", "inspect", "--format={{.Id}}", image]).trim();
    }
    return inspect.stdout.trim();
};

const removeContainer = (container: string): void => {
    shell("docker", ["rm", "--force", container], { allowFailure: true });
};

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const runToFiles = async (
    command: string,
    args: string[],
    options: {
        cwd: string;
        env?: NodeJS.ProcessEnv;
        stdoutPath: string;
        stderrPath: string;
        tee?: boolean;
        timeoutMs?: number;
    },
): Promise<CommandResult> => {
    const stdout = createWriteStream(options.stdoutPath);
    const stderr = createWriteStream(options.stderrPath);
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.stdout.on("data", (chunk: Buffer) => {
        if (options.tee === true) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
        if (options.tee === true) process.stderr.write(chunk);
    });
    let processError: Error | undefined;
    let timedOut = false;
    const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, options.timeoutMs);
    child.once("error", (error) => {
        processError = error;
    });
    const result = await new Promise<CommandResult>((accept) => {
        child.once("close", (status, signal) => {
            if (timer !== undefined) clearTimeout(timer);
            accept({
                status,
                signal,
                timedOut,
                ...(processError === undefined ? {} : { error: processError }),
            });
        });
    });
    await Promise.all([finished(stdout), finished(stderr)]);
    return result;
};

const streamGitDiff = async (
    repository: string,
    args: string[],
    path: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
    const fd = openSync(path, "w");
    const child = spawn("git", ["-C", repository, ...args], {
        env,
        stdio: ["ignore", fd, "pipe"],
    });
    let errorText = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
        errorText += chunk;
    });
    const result = await new Promise<CommandResult>((accept) => {
        child.once("error", (error) => accept({
            status: null,
            signal: null,
            timedOut: false,
            error,
        }));
        child.once("close", (status, signal) => accept({
            status,
            signal,
            timedOut: false,
        }));
    });
    closeSync(fd);
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
        throw new Error(`git diff failed (${result.status ?? result.signal ?? "unknown"}): ${errorText.trim()}`);
    }
};

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

const validateFixture = (manifest: Manifest, taskDir: string): OracleConfig => {
    assert.equal(manifest.schemaVersion, 1, "benchlet manifest schema must be version 1");
    assert.ok(manifest.repositoryUrl !== "", "benchlet manifest must pin a repository URL");
    assert.match(manifest.baseCommit, /^[0-9a-f]{40}$/, "benchlet manifest must pin a full Git commit");
    for (const [name, expected] of Object.entries(manifest.files)) {
        const path = resolve(taskDir, name);
        if (!existsSync(path)) throw new Error(`external task fixture is missing ${name}: ${path}`);
        const actual = sha256(path);
        if (actual !== expected) {
            throw new Error(`external task fixture drifted at ${name}: expected ${expected}, received ${actual}`);
        }
    }
    const config = JSON.parse(readFileSync(resolve(taskDir, "tests/config.json"), "utf8")) as OracleConfig;
    assert.equal(config.base_commit, manifest.baseCommit, "oracle base commit must match the benchlet manifest");
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

const ensureRepositoryCache = (manifest: Manifest, cache: string): void => {
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

const sourceProvenance = (repository: string): {
    path: string;
    head: string;
    remote: string | null;
    clean: boolean;
} => {
    const status = git(repository, ["status", "--porcelain"]);
    const remote = git(repository, ["remote", "get-url", "origin"], { allowFailure: true }).trim();
    return {
        path: repository,
        head: git(repository, ["rev-parse", "HEAD"]).trim(),
        remote: remote === "" ? null : remote,
        clean: status === "",
    };
};

export const allocateRun = (runsRoot: string, task: string, model: string): string => {
    return allocateRunDirectory(runsRoot, ["deepswe", task, model]);
};

const snapshotTask = (
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

const cloneBase = (cache: string, destination: string, baseCommit: string): void => {
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

const prepareCandidateRepository = (
    manifest: Manifest,
    repositoryCache: string,
    destination: string,
): void => {
    if (isDockerManifest(manifest)) {
        copyDockerBase(manifest, destination);
        return;
    }
    assert.ok(isHostManifest(manifest), "benchlet manifest environment and verifier are incompatible");
    cloneBase(repositoryCache, destination, manifest.baseCommit);
};

const capturePatches = async (
    repository: string,
    runDir: string,
    baseCommit: string,
): Promise<{
    branch: string;
    head: string;
    status: string;
    committed: boolean;
    submissionSha256: string;
    workingSha256: string;
}> => {
    const status = git(repository, ["status", "--porcelain=v2", "--branch"]);
    const branch = git(repository, ["branch", "--show-current"]).trim();
    const head = git(repository, ["rev-parse", "HEAD"]).trim();
    const submissionPath = resolve(runDir, "model.patch");
    await streamGitDiff(repository, ["diff", "--binary", baseCommit, "HEAD", "--"], submissionPath);

    const alternateIndex = resolve(runDir, "working-tree.index");
    const indexEnv = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    git(repository, ["read-tree", "HEAD"], { env: indexEnv });
    git(repository, ["add", "-A"], { env: indexEnv });
    const workingPath = resolve(runDir, "working.patch");
    await streamGitDiff(repository, ["diff", "--cached", "--binary", baseCommit, "--"], workingPath, indexEnv);
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

const regexEscape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const gradeGoPatch = async (
    label: string,
    patchPath: string,
    artifactDir: string,
    repositoryCache: string,
    manifest: HostManifest,
    taskDir: string,
    config: OracleConfig,
): Promise<OracleResult> => {
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
): Promise<OracleResult> => {
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
        shell("docker", ["cp", patchPath, `${container}:/logs/artifacts/model.patch`]);
        const args = ["exec", container, "bash", "/tests/test.sh"];
        const result = await runToFiles("docker", args, {
            cwd: benchRoot,
            stdoutPath: resolve(artifactDir, "stdout.log"),
            stderrPath: resolve(artifactDir, "stderr.log"),
            timeoutMs: manifest.verifier.timeoutSeconds * 1_000,
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

const gradePatch = (
    label: string,
    patchPath: string,
    artifactDir: string,
    repositoryCache: string,
    manifest: Manifest,
    taskDir: string,
    config: OracleConfig,
): Promise<OracleResult> => isDockerManifest(manifest)
    ? gradeTaskPatch(label, patchPath, artifactDir, manifest, taskDir, config)
    : isHostManifest(manifest)
        ? gradeGoPatch(label, patchPath, artifactDir, repositoryCache, manifest, taskDir, config)
        : Promise.reject(new Error("benchlet manifest environment and verifier are incompatible"));

export const digestSummary = (digest: DigestJson): {
    modelTurns: number;
    providerAttempts: number;
    rejectedAttempts: number;
    models: string[];
    usage: {
        prompt: number;
        completion: number;
        reasoning: number;
        cached: number;
        costUsd: number | null;
    };
    loopOutcomes: Array<{
        workerId: number;
        workerName: string | null;
        loop: number;
        status: number;
        terminalMessage: string | null;
        terminatedBy: string | null;
        problem: Record<string, unknown> | null;
    }>;
    operationCounts: Record<string, number>;
    problemTypes: Record<string, number>;
} => {
    const operationCounts: Record<string, number> = {};
    const problemTypes: Record<string, number> = {};
    for (const entry of digest.log_entries) {
        if (entry.origin !== "model" || entry.op === null) continue;
        operationCounts[entry.op] = (operationCounts[entry.op] ?? 0) + 1;
        if (entry.status_rx >= 400) {
            const type = entry.problem?.type ?? "unknown";
            problemTypes[type] = (problemTypes[type] ?? 0) + 1;
        }
    }
    const {
        providerAttempts,
        rejectedAttempts,
        models,
        ...usage
    } = summarizeDigestAccounting(digest);
    const workerNames = new Map(digest.workers.map((worker) => [worker.id, worker.name]));
    return {
        modelTurns: digest.turns.filter((turn) => turn.model !== null && turn.model !== "unknown").length,
        providerAttempts,
        rejectedAttempts,
        models,
        usage,
        loopOutcomes: digest.loops.map((loop) => ({
            workerId: loop.worker_id,
            workerName: workerNames.get(loop.worker_id) ?? null,
            loop: loop.sequence,
            status: loop.status,
            terminalMessage: typeof loop.result?.content === "string" ? loop.result.content : null,
            terminatedBy: loop.terminated_by,
            problem: loop.result?.problem ?? null,
        })),
        operationCounts,
        problemTypes,
    };
};

const environmentKeyNames = (env: NodeJS.ProcessEnv): string[] =>
    Object.keys(env)
        .filter((name) => /(?:API_KEY|_TOKEN|BASE_URL)$/.test(name))
        .toSorted();

const envFileKeyNames = (path: string): string[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
        .split("\n")
        .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined)
        .toSorted();
};

export const requiemIsComplete = (
    status: number | null,
    markdownExists: boolean,
    reportExists: boolean,
): boolean => status === 0 && markdownExists && reportExists;

export const requiemModelAlias = (
    enabled: boolean,
    configured: string | undefined,
): string | null => {
    if (!enabled) return null;
    if (configured === undefined || configured.trim() === "") {
        throw new Error("PLURNK_BENCHLET_REQUIEM_MODEL must name a model alias when requiems are enabled");
    }
    return configured;
};

const requiemSummary = (path: string): Record<string, unknown> => {
    const report = JSON.parse(readFileSync(path, "utf8")) as RequiemAccountingInput;
    return summarizeRequiemAccounting(report);
};

const main = async (): Promise<void> => {
    process.loadEnvFile(resolve(benchRoot, ".env.defaults"));
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: {
            preflight: { type: "boolean", default: false },
            task: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
    });
    if (positionals.length > 1) throw new Error("benchlet accepts at most one model alias");
    const task = values.task ?? process.env.PLURNK_BENCHLET_TASK;
    if (task === undefined || task.trim() === "") throw new Error("benchlet requires a task name");
    const manifestPath = manifestPathForTask(task);
    if (!existsSync(manifestPath)) throw new Error(`benchlet has no pinned manifest for task: ${task}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    assert.equal(manifest.task, task, "benchlet manifest task must match its selection");

    const preflightOnly = values.preflight;
    const model = positionals[0] ?? process.env.PLURNK_BENCHLET_MODEL;
    if (model === undefined || model.trim() === "") throw new Error("benchlet requires a model alias");
    const taskCache = resolveFrom(benchRoot, process.env.PLURNK_BENCHLET_TASK_CACHE ?? "");
    const taskDir = resolve(taskCache, manifest.task);
    const repositoryCacheRoot = resolveFrom(
        benchRoot,
        process.env.PLURNK_BENCHLET_REPOSITORY_CACHE_ROOT ?? "",
    );
    const repositoryCache = resolve(repositoryCacheRoot, `${manifest.task}.git`);
    const runsRoot = resolveFrom(benchRoot, process.env.PLURNK_BENCHLET_RUNS_ROOT ?? "");
    const serviceRoot = resolveFrom(benchRoot, process.env.PLURNK_BENCHLET_SERVICE_ROOT ?? "");
    const clientRoot = requiredClientCheckout(
        benchRoot,
        process.env,
        "PLURNK_BENCHLET_CLIENT_ROOT",
    );
    const operatorEnv = expandHome(process.env.PLURNK_BENCHLET_OPERATOR_ENV ?? "");
    const candidatePolicy = candidatePolicyPath(serviceRoot);
    const candidateTimeout = Number(process.env.PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC);
    const candidateOverhead = Number(process.env.PLURNK_BENCHLET_CANDIDATE_OVERHEAD_SEC);
    const requiemTimeout = Number(process.env.PLURNK_BENCHLET_REQUIEM_TIMEOUT_SEC);
    const requiemEnabled = process.env.PLURNK_BENCHLET_REQUIEM === "1";
    const requiemModel = requiemModelAlias(
        requiemEnabled,
        process.env.PLURNK_BENCHLET_REQUIEM_MODEL,
    );
    if (!Number.isSafeInteger(candidateTimeout) || candidateTimeout <= 0) {
        throw new Error("PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC must be a positive integer");
    }
    if (!Number.isSafeInteger(candidateOverhead) || candidateOverhead <= 0) {
        throw new Error("PLURNK_BENCHLET_CANDIDATE_OVERHEAD_SEC must be a positive integer");
    }
    if (!Number.isSafeInteger(requiemTimeout) || requiemTimeout <= 0) {
        throw new Error("PLURNK_BENCHLET_REQUIEM_TIMEOUT_SEC must be a positive integer");
    }
    if (!existsSync(operatorEnv)) throw new Error(`operator model environment is missing: ${operatorEnv}`);
    if (!existsSync(candidatePolicy)) throw new Error(`candidate personality is missing: ${candidatePolicy}`);

    const config = validateFixture(manifest, taskDir);
    const imageId = manifest.environment.kind === "docker"
        ? dockerImageId(manifest.environment.image)
        : null;
    if (manifest.environment.kind === "host") ensureRepositoryCache(manifest, repositoryCache);
    const sources = {
        bench: sourceProvenance(benchRoot),
        service: sourceProvenance(serviceRoot),
        client: sourceProvenance(clientRoot),
    };
    for (const [name, source] of Object.entries(sources)) {
        if (!source.clean) throw new Error(`${name} source is dirty; commit the exact source before a diagnostic run`);
    }

    if (preflightOnly) {
        const preflightRoot = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-preflight-"));
        try {
            const emptyPatch = resolve(preflightRoot, "baseline.patch");
            writeFileSync(emptyPatch, "");
            const baseline = await gradePatch(
                "preflight",
                emptyPatch,
                resolve(preflightRoot, "oracle"),
                repositoryCache,
                manifest,
                taskDir,
                config,
            );
            if (baseline.p2pPassed !== baseline.p2pTotal || baseline.f2pPassed !== 0) {
                throw new Error(
                    `external oracle baseline is invalid: p2p ${baseline.p2pPassed}/${baseline.p2pTotal}, `
                    + `f2p ${baseline.f2pPassed}/${baseline.f2pTotal}`,
                );
            }
            process.stdout.write(`${JSON.stringify({ status: "ready", baseline }, null, 2)}\n`);
        } finally {
            rmSync(preflightRoot, { recursive: true, force: true });
        }
        return;
    }

    const runDir = allocateRun(runsRoot, manifest.task, model);
    const candidatePolicySnapshot = candidatePolicySnapshotPath(runDir);
    copyFileSync(candidatePolicy, candidatePolicySnapshot);
    snapshotTask(runDir, manifestPath, manifest, taskDir);
    const startedAt = new Date();
    activeRunDir = runDir;
    activeStartedAt = startedAt;
    const provenance = {
        schemaVersion: 1,
        state: "running",
        startedAt: startedAt.toISOString(),
        invocation: {
            command: relative(benchRoot, resolve(moduleDir, "benchlet.sh")),
            args: ["--task", manifest.task, model],
            cwd: benchRoot,
        },
        task: {
            name: manifest.task,
            repositoryUrl: manifest.repositoryUrl,
            baseCommit: manifest.baseCommit,
            manifestSha256: sha256(manifestPath),
            files: manifest.files,
            environment: {
                ...manifest.environment,
                imageId,
            },
            verifier: manifest.verifier,
        },
        modelAlias: model,
        sources,
        webMaterialization: webMaterializationProvenance(process.env),
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        configuration: {
            candidateTimeoutSeconds: candidateTimeout,
            candidateOverheadSeconds: candidateOverhead,
            requiemTimeoutSeconds: requiemTimeout,
            requiemModelAlias: requiemModel,
            oracleSuiteTimeoutSeconds: manifest.verifier.kind === "go"
                ? Object.fromEntries(
                    manifest.verifier.suites.map((suite) => [suite.name, suite.timeoutSeconds]),
                )
                : null,
            oracleTaskTimeoutSeconds: manifest.verifier.kind === "task"
                ? manifest.verifier.timeoutSeconds
                : null,
            requiemEnabled,
            operatorEnv,
            operatorEnvKeys: envFileKeyNames(operatorEnv),
            candidatePolicy: {
                sourcePath: candidatePolicy,
                snapshotPath: candidatePolicySnapshot,
                sha256: sha256(candidatePolicySnapshot),
            },
            shellCredentialKeys: environmentKeyNames(process.env),
        },
    };
    writeJson(resolve(runDir, "provenance.json"), provenance);

    activeStage = "oracle-baseline";
    const emptyPatch = resolve(runDir, "baseline.patch");
    writeFileSync(emptyPatch, "");
    const baseline = await gradePatch(
        "baseline",
        emptyPatch,
        resolve(runDir, "oracle-baseline"),
        repositoryCache,
        manifest,
        taskDir,
        config,
    );
    writeJson(resolve(runDir, "oracle-baseline.json"), baseline);
    if (baseline.p2pPassed !== baseline.p2pTotal || baseline.f2pPassed !== 0) {
        throw new Error(
            `external oracle baseline is invalid: p2p ${baseline.p2pPassed}/${baseline.p2pTotal}, `
            + `f2p ${baseline.f2pPassed}/${baseline.f2pTotal}`,
        );
    }

    const repository = resolve(runDir, "repo");
    prepareCandidateRepository(manifest, repositoryCache, repository);
    const instruction = readFileSync(resolve(taskDir, "instruction.md"), "utf8");
    const candidateArgs = [
        "scripts/candidate.mjs",
        "--auto",
        "--project-root",
        repository,
        "--timeout",
        String(candidateTimeout),
        instruction,
    ];
    const candidateEnvironmentOverrides = {
        PLURNK_CANDIDATE_DIR: runDir,
        PLURNK_CANDIDATE_MODEL: model,
        PLURNK_CLIENT_CHECKOUT: clientRoot,
        PLURNK_SERVICE_POLICY: candidatePolicySnapshot,
    };
    writeJson(resolve(runDir, "candidate-command.json"), {
        command: process.execPath,
        args: candidateArgs,
        cwd: serviceRoot,
        environmentOverrides: candidateEnvironmentOverrides,
    });
    activeStage = "candidate";
    const candidate = await runToFiles(process.execPath, candidateArgs, {
        cwd: serviceRoot,
        env: {
            ...process.env,
            ...candidateEnvironmentOverrides,
        },
        stdoutPath: resolve(runDir, "candidate.stdout.log"),
        stderrPath: resolve(runDir, "candidate.stderr.log"),
        tee: true,
        timeoutMs: (candidateTimeout + candidateOverhead) * 1_000,
    });

    activeStage = "capture";
    const patchState = await capturePatches(repository, runDir, manifest.baseCommit);
    writeJson(resolve(runDir, "git-state.json"), patchState);
    const digestPath = resolve(runDir, "digest/digest.json");
    if (!existsSync(digestPath)) throw new Error("candidate did not produce a digest");
    const digest = JSON.parse(readFileSync(digestPath, "utf8")) as DigestJson;
    const summary = digestSummary(digest);
    if ((summary.providerAttempts as number) === 0) {
        throw new Error("candidate completed no provider exchange; the run is infrastructure, not an oracle attempt");
    }

    activeStage = "oracle-working";
    const workingOracle = await gradePatch(
        "working",
        resolve(runDir, "working.patch"),
        resolve(runDir, "oracle-working"),
        repositoryCache,
        manifest,
        taskDir,
        config,
    );
    writeJson(resolve(runDir, "oracle-working.json"), workingOracle);
    activeStage = "oracle-submission";
    const submissionReusedWorking = patchState.submissionSha256 === patchState.workingSha256;
    const submissionOracle = submissionReusedWorking
        ? workingOracle
        : await gradePatch(
            "submission",
            resolve(runDir, "model.patch"),
            resolve(runDir, "oracle-submission"),
            repositoryCache,
            manifest,
            taskDir,
            config,
        );
    writeJson(resolve(runDir, "oracle-submission.json"), submissionOracle);
    if (submissionReusedWorking) {
        const reuseDir = resolve(runDir, "oracle-submission");
        mkdirSync(reuseDir);
        writeJson(resolve(reuseDir, "reused.json"), {
            reusedFrom: "oracle-working",
            reason: "working.patch and model.patch have identical SHA-256 hashes",
            patchSha256: patchState.submissionSha256,
        });
    }

    let requiem: Record<string, unknown> = { enabled: requiemEnabled, status: null };
    if (requiemModel !== null) {
        activeStage = "requiem";
        const requiemArgs = [
            `--env-file=${operatorEnv}`,
            "--conditions=plurnk-dev",
            "plurnk-core/bin/digest.ts",
            "--requiem",
            resolve(runDir, "plurnk.db"),
            resolve(runDir, "digest"),
        ];
        const result = await runToFiles(process.execPath, requiemArgs, {
            cwd: serviceRoot,
            env: {
                ...process.env,
                PLURNK_MODEL: requiemModel,
            },
            stdoutPath: resolve(runDir, "requiem.stdout.log"),
            stderrPath: resolve(runDir, "requiem.stderr.log"),
            tee: true,
            timeoutMs: requiemTimeout * 1_000,
        });
        const markdownPath = resolve(runDir, "digest/requiem.md");
        const reportPath = resolve(runDir, "digest/requiem.json");
        const complete = requiemIsComplete(
            result.status,
            existsSync(markdownPath),
            existsSync(reportPath),
        );
        requiem = {
            enabled: true,
            modelAlias: requiemModel,
            status: result.status,
            signal: result.signal,
            timedOut: result.timedOut,
            error: result.error?.message ?? null,
            complete,
            markdown: existsSync(markdownPath) ? relative(runDir, markdownPath) : null,
            report: existsSync(reportPath) ? relative(runDir, reportPath) : null,
            ...(existsSync(reportPath) ? { summary: requiemSummary(reportPath) } : {}),
        };
    }

    activeStage = "finalize";
    const completedAt = new Date();
    const harnessStatus = requiemEnabled && requiem.complete !== true ? "incomplete" : "complete";
    const requiemCostUsd = !requiemEnabled
        ? 0
        : typeof requiem.summary === "object"
            && requiem.summary !== null
            && "costUsd" in requiem.summary
            && (typeof requiem.summary.costUsd === "number" || requiem.summary.costUsd === null)
            ? requiem.summary.costUsd
            : null;
    writeJson(resolve(runDir, "result.json"), {
        schemaVersion: 1,
        harnessStatus,
        totalCostUsd: addSettledUsd(summary.usage.costUsd, requiemCostUsd),
        candidate: {
            status: candidate.status,
            signal: candidate.signal,
            timedOut: candidate.timedOut,
            error: candidate.error?.message ?? null,
        },
        summary,
        git: patchState,
        oracle: {
            baseline,
            working: workingOracle,
            submission: submissionOracle,
            submissionEvidence: {
                reusedWorking: submissionReusedWorking,
                patchSha256: patchState.submissionSha256,
            },
        },
        requiem,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
    });
    writeJson(resolve(runDir, "provenance.json"), {
        ...provenance,
        state: "complete",
        completedAt: completedAt.toISOString(),
    });
    process.stdout.write(`artifact=${runDir}\n`);
    if (harnessStatus !== "complete") process.exitCode = 1;
};

if (import.meta.main) {
    void main().catch((error) => {
        const rendered = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`${rendered}\n`);
        if (activeRunDir !== undefined) {
            const completedAt = new Date();
            writeFileSync(resolve(activeRunDir, "infrastructure-error.log"), `${rendered}\n`);
            writeJson(resolve(activeRunDir, "result.json"), {
                schemaVersion: 1,
                harnessStatus: "infrastructure_error",
                infrastructure: {
                    stage: activeStage,
                    message: error instanceof Error ? error.message : String(error),
                },
                startedAt: activeStartedAt?.toISOString() ?? null,
                completedAt: completedAt.toISOString(),
                durationMs: activeStartedAt === undefined ? null : completedAt.getTime() - activeStartedAt.getTime(),
            });
            const provenancePath = resolve(activeRunDir, "provenance.json");
            if (existsSync(provenancePath)) {
                const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
                writeJson(provenancePath, {
                    ...provenance,
                    state: "infrastructure_error",
                    failedStage: activeStage,
                    completedAt: completedAt.toISOString(),
                });
            }
            process.stderr.write(`artifact=${activeRunDir}\n`);
        }
        process.exitCode = 1;
    });
}
