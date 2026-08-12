import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
    basename,
    dirname,
    relative,
    resolve,
} from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
    runToFiles,
} from "../deepswe/benchlet.ts";
import { allocateRunDirectory } from "../src/run-directory.ts";
import { requiredClientCheckout } from "../src/client-checkout.ts";
import {
    summarizeDigestAccounting,
    type AccountingSummary,
    type ProviderAccountingProjection,
} from "../src/accounting.ts";
import { webMaterializationProvenance } from "../src/web-materialization.ts";

interface ExactOracle {
    readonly kind: "exact";
    readonly answer: string;
}

interface ClaimsOracle {
    readonly kind: "claims";
    readonly dataset: {
        readonly name: string;
        readonly revision: string;
        readonly taskId: string;
    };
    readonly claims: string[];
}

interface AtlasTask {
    readonly schemaVersion: 1;
    readonly name: string;
    readonly source: string;
    readonly prompt: string;
    readonly enabledTools: string[];
    readonly oracle: ExactOracle | ClaimsOracle;
}

interface Digest {
    readonly workspaces: Array<{
        readonly accounting: ProviderAccountingProjection | null;
    }>;
    readonly loops: Array<{
        readonly prompt: string;
        readonly status: number;
        readonly terminal_message: string | null;
        readonly result?: {
            readonly status: number;
            readonly problem?: Record<string, unknown>;
        };
    }>;
    readonly turn_attempts: Array<{
        readonly accepted: boolean | null;
    }>;
    readonly provider_requests: Array<{
        readonly accounting: { readonly model: string } | null;
    }>;
    readonly log_entries: Array<{
        readonly origin: string;
        readonly op: string;
        readonly status_rx: number;
        readonly stream?: string;
        readonly target?: string | null;
    }>;
}

interface CommandResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly error?: Error;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");
let activeRunDir: string | undefined;
let activeStartedAt: Date | undefined;
let activeStage = "preflight";
let activeContainer: string | undefined;

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const expandHome = (value: string): string =>
    value === "~"
        ? homedir()
        : value.startsWith("~/")
            ? resolve(homedir(), value.slice(2))
            : value;

const resolveFrom = (root: string, value: string): string =>
    resolve(root, expandHome(value));

const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value.trim() === "") {
        throw new Error(`${name} must be declared in .env.defaults.`);
    }
    return value;
};

const positiveInteger = (name: string): number => {
    const raw = required(name);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer.`);
    }
    return value;
};

const integer = (name: string): number => {
    const raw = required(name);
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
        throw new Error(`${name} must be an integer.`);
    }
    return value;
};

const ratio = (name: string): number => {
    const raw = required(name);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${name} must be a number from 0 through 1.`);
    }
    return value;
};

const shell = (
    command: string,
    args: string[],
    options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        allowFailure?: boolean;
    } = {},
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

const sourceProvenance = (repository: string): {
    readonly path: string;
    readonly head: string;
    readonly remote: string | null;
    readonly clean: boolean;
} => {
    const status = shell("git", ["-C", repository, "status", "--porcelain"]);
    const remote = shell(
        "git",
        ["-C", repository, "remote", "get-url", "origin"],
        { allowFailure: true },
    ).trim();
    return {
        path: repository,
        head: shell("git", ["-C", repository, "rev-parse", "HEAD"]).trim(),
        remote: remote === "" ? null : remote,
        clean: status === "",
    };
};

const ensureAtlasSource = (
    repository: string,
    revision: string,
    cache: string,
): void => {
    if (!existsSync(cache)) {
        mkdirSync(dirname(cache), { recursive: true });
        shell("git", ["clone", "--quiet", repository, cache]);
    }
    const remote = shell("git", ["-C", cache, "remote", "get-url", "origin"]).trim();
    if (remote !== repository) {
        throw new Error(`Atlas source cache origin is '${remote}', expected '${repository}'.`);
    }
    shell("git", ["-C", cache, "fetch", "--quiet", "--depth=1", "origin", revision]);
    const fetched = shell("git", ["-C", cache, "rev-parse", "FETCH_HEAD"]).trim();
    if (fetched !== revision) {
        throw new Error(`Atlas source fetch resolved '${fetched}', expected '${revision}'.`);
    }
    const current = shell(
        "git",
        ["-C", cache, "rev-parse", "HEAD"],
        { allowFailure: true },
    ).trim();
    if (current !== revision) {
        if (shell("git", ["-C", cache, "status", "--porcelain"]).trim() !== "") {
            throw new Error(`Atlas source cache is dirty: ${cache}`);
        }
        shell("git", ["-C", cache, "checkout", "--quiet", "--detach", revision]);
    }
    if (shell("git", ["-C", cache, "status", "--porcelain"]).trim() !== "") {
        throw new Error(`Atlas source cache is dirty: ${cache}`);
    }
};

const environmentKeyNames = (env: NodeJS.ProcessEnv): string[] =>
    Object.keys(env)
        .filter((name) => /(?:API_KEY|_TOKEN|BASE_URL)$/.test(name))
        .toSorted();

export const withoutMcpServers = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
    Object.fromEntries(
        Object.entries(env).filter(([name]) =>
            !name.startsWith("PLURNK_MCP_")),
    );

const imageId = (image: string): string => {
    const inspect = spawnSync(
        "docker",
        ["image", "inspect", "--format={{.Id}}", image],
        { encoding: "utf8" },
    );
    if (inspect.error !== undefined) throw inspect.error;
    if (inspect.status !== 0) shell("docker", ["pull", image]);
    return shell(
        "docker",
        ["image", "inspect", "--format={{.Id}}", image],
    ).trim();
};

const removeContainer = (container: string): void => {
    shell("docker", ["rm", "--force", container], { allowFailure: true });
};

const captureContainerLog = (container: string, runDir: string): void => {
    const result = spawnSync("docker", ["logs", container], {
        encoding: "utf8",
    });
    writeFileSync(
        resolve(runDir, "atlas-container.log"),
        `${result.stdout}${result.stderr}`,
    );
};

const startContainer = (
    image: string,
    containerPort: number,
    runDir: string,
): {
    readonly container: string;
    readonly sandboxUrl: string;
} => {
    const container = `plurnk-${basename(runDir)}`;
    shell("docker", [
        "create",
        "--name",
        container,
        "--publish",
        `127.0.0.1::${containerPort}`,
        image,
    ]);
    try {
        shell("docker", ["start", container]);
        const address = shell(
            "docker",
            ["port", container, `${containerPort}/tcp`],
        ).trim();
        const match = /^127\.0\.0\.1:(\d+)$/.exec(address);
        if (match === null) {
            throw new Error(`Atlas container published an unexpected address: ${address}`);
        }
        return {
            container,
            sandboxUrl: `http://127.0.0.1:${match[1]}`,
        };
    } catch (error) {
        removeContainer(container);
        throw error;
    }
};

const delay = (milliseconds: number): Promise<void> =>
    new Promise((accept) => setTimeout(accept, milliseconds));

const awaitAtlas = async (
    sandboxUrl: string,
    timeoutMs: number,
    pollMs: number,
    requestTimeoutMs: number,
): Promise<unknown[]> => {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(new URL("/list-tools", sandboxUrl), {
                method: "POST",
                signal: AbortSignal.timeout(requestTimeoutMs),
            });
            if (!response.ok) {
                throw new Error(`Atlas readiness answered HTTP ${response.status}.`);
            }
            const value: unknown = await response.json();
            if (!Array.isArray(value)) {
                throw new Error("Atlas readiness did not return a tool array.");
            }
            return value;
        } catch (error) {
            lastError = error;
        }
        await delay(pollMs);
    }
    throw new Error("Atlas sandbox did not become ready before its configured deadline.", {
        cause: lastError,
    });
};

export const missingAtlasTools = (
    catalog: readonly unknown[],
    enabledTools: readonly string[],
): string[] => {
    const available = new Set(catalog.flatMap((candidate) => {
        if (
            candidate === null
            || typeof candidate !== "object"
            || Array.isArray(candidate)
            || typeof (candidate as { name?: unknown }).name !== "string"
        ) {
            return [];
        }
        return [(candidate as { name: string }).name];
    }));
    return enabledTools.filter((name) => !available.has(name));
};

const taskPath = (name: string): string => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
        throw new Error(`Invalid Atlas task name '${name}'.`);
    }
    return resolve(moduleDir, "tasks", `${name}.json`);
};

const readTask = (name: string): {
    readonly path: string;
    readonly task: AtlasTask;
} => {
    const path = taskPath(name);
    if (!existsSync(path)) throw new Error(`Atlas task is missing: ${path}`);
    const task = JSON.parse(readFileSync(path, "utf8")) as AtlasTask;
    if (
        task.schemaVersion !== 1
        || task.name !== name
        || task.prompt.trim() === ""
        || !Array.isArray(task.enabledTools)
        || task.enabledTools.length === 0
        || task.enabledTools.some((tool) => typeof tool !== "string" || tool === "")
    ) {
        throw new Error(`Atlas task '${name}' is malformed.`);
    }
    if (
        task.oracle === null
        || typeof task.oracle !== "object"
        || (task.oracle.kind !== "exact" && task.oracle.kind !== "claims")
    ) {
        throw new Error(`Atlas task '${name}' has an unknown oracle.`);
    }
    if (
        task.oracle.kind === "exact"
        && task.oracle.answer.trim() === ""
    ) {
        throw new Error(`Atlas task '${name}' has an empty exact oracle.`);
    }
    if (
        task.oracle.kind === "claims"
        && (
            task.oracle.dataset.name.trim() === ""
            || !/^[0-9a-f]{40}$/.test(task.oracle.dataset.revision)
            || task.oracle.dataset.taskId.trim() === ""
            || !Array.isArray(task.oracle.claims)
            || task.oracle.claims.length === 0
            || task.oracle.claims.some((claim) => typeof claim !== "string" || claim.trim() === "")
        )
    ) {
        throw new Error(`Atlas task '${name}' has a malformed claims oracle.`);
    }
    return { path, task };
};

const commandFailure = (label: string, result: CommandResult): void => {
    if (result.error !== undefined) throw result.error;
    if (result.timedOut) throw new Error(`${label} timed out.`);
    if (result.status !== 0) {
        throw new Error(`${label} failed (${result.status ?? result.signal ?? "unknown"}).`);
    }
};

const buildSource = async (
    label: string,
    root: string,
    runDir: string,
): Promise<void> => {
    const result = await runToFiles("npm", ["run", "build"], {
        cwd: root,
        stdoutPath: resolve(runDir, `${label}-build.stdout.log`),
        stderrPath: resolve(runDir, `${label}-build.stderr.log`),
    });
    commandFailure(`${label} build`, result);
};

export const answerMatches = (answer: string, expected: string): boolean => {
    const escaped = expected.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, "i").test(answer);
};

const csvCell = (value: string): string => `"${value.replaceAll("\"", "\"\"")}"`;

export const atlasScoringCsv = (
    task: AtlasTask & { readonly oracle: ClaimsOracle },
    answer: string,
): {
    readonly groundTruth: string;
    readonly model: string;
} => ({
    groundTruth: [
        ["TASK", "PROMPT", "GTFA_CLAIMS"].map(csvCell).join(","),
        [
            task.oracle.dataset.taskId,
            task.prompt,
            JSON.stringify(task.oracle.claims),
        ].map(csvCell).join(","),
    ].join("\n") + "\n",
    model: [
        ["task_id", "response"].map(csvCell).join(","),
        [task.oracle.dataset.taskId, answer].map(csvCell).join(","),
    ].join("\n") + "\n",
});

export const atlasClientArgs = (options: {
    readonly filesItems: number;
    readonly maxTurns: number;
    readonly timeoutSeconds: number;
    readonly prompt: string;
}): string[] => [
    "--auto",
    "--project-root",
    "",
    "--no-git",
    `--files-items=${options.filesItems}`,
    "--max-turns",
    String(options.maxTurns),
    "--timeout",
    String(options.timeoutSeconds),
    options.prompt,
];

export const requiemIsComplete = (
    status: number | null,
    markdown: boolean,
    report: boolean,
): boolean => status === 0 && markdown && report;

export const successfulExecutorCalls = (
    entries: Digest["log_entries"],
    runtime: string,
    allowedTools: readonly string[],
): number => entries.filter((entry) =>
    entry.origin === "model"
    && entry.op === "EXEC"
    && entry.status_rx < 400
    && entry.stream?.startsWith(`${runtime}:///`) === true
    && typeof entry.target === "string"
    && allowedTools.includes(entry.target)).length;

const usageSummary = (digest: Digest): AccountingSummary => {
    return summarizeDigestAccounting({
        workspaces: digest.workspaces,
        provider_requests: digest.provider_requests,
        turn_attempts: digest.turn_attempts,
    });
};

const runRequiem = async (
    enabled: boolean,
    model: string,
    timeoutSeconds: number,
    operatorEnv: string,
    serviceRoot: string,
    runDir: string,
): Promise<Record<string, unknown>> => {
    if (!enabled) return { enabled: false };
    const result = await runToFiles(process.execPath, [
        `--env-file=${operatorEnv}`,
        "--conditions=plurnk-dev",
        "plurnk-core/bin/digest.ts",
        "--requiem",
        resolve(runDir, "plurnk.db"),
        resolve(runDir, "digest"),
    ], {
        cwd: serviceRoot,
        env: {
            ...process.env,
            PLURNK_MODEL: model,
        },
        stdoutPath: resolve(runDir, "requiem.stdout.log"),
        stderrPath: resolve(runDir, "requiem.stderr.log"),
        tee: true,
        timeoutMs: timeoutSeconds * 1_000,
    });
    const markdown = existsSync(resolve(runDir, "digest", "requiem.md"));
    const report = existsSync(resolve(runDir, "digest", "requiem.json"));
    return {
        enabled: true,
        model,
        status: result.status,
        signal: result.signal,
        timedOut: result.timedOut,
        error: result.error?.message ?? null,
        complete: requiemIsComplete(result.status, markdown, report),
        markdown,
        report,
    };
};

const scoreClaims = async (
    task: AtlasTask & { readonly oracle: ClaimsOracle },
    answer: string,
    model: string,
    sourceRoot: string,
    runDir: string,
    timeoutSeconds: number,
    judgeModel: string,
    judgeConcurrency: number,
): Promise<{
    readonly kind: "claims";
    readonly coverage: number;
    readonly judgeModel: string;
    readonly sourceRevision: string;
    readonly dataset: ClaimsOracle["dataset"];
}> => {
    const apiKey = required("PLURNK_API_KEY");
    const configuredBaseUrl = required("OPENAI_BASE_URL").replace(/\/v1\/?$/, "");
    const scoringDir = resolve(runDir, "atlas-scoring");
    mkdirSync(scoringDir);
    const groundTruthPath = resolve(scoringDir, "ground-truth.csv");
    const modelPath = resolve(scoringDir, "model-output.csv");
    const csv = atlasScoringCsv(task, answer);
    writeFileSync(groundTruthPath, csv.groundTruth);
    writeFileSync(modelPath, csv.model);

    const result = await runToFiles("uv", [
        "run",
        "--isolated",
        "--with-requirements",
        resolve(sourceRoot, "requirements.txt"),
        "python",
        resolve(sourceRoot, "services", "scoring", "score_claims.py"),
        "--groundtruth-file",
        groundTruthPath,
        "--model-file",
        modelPath,
        "--model-name",
        model,
        "--evaluator-model",
        judgeModel,
        "--output-dir",
        scoringDir,
        "--concurrency",
        String(judgeConcurrency),
        "--num-tasks",
        "1",
        "--verbose",
    ], {
        cwd: sourceRoot,
        env: {
            ...process.env,
            LLM_API_KEY: apiKey,
            LLM_BASE_URL: configuredBaseUrl,
        },
        stdoutPath: resolve(scoringDir, "scorer.stdout.log"),
        stderrPath: resolve(scoringDir, "scorer.stderr.log"),
        tee: true,
        timeoutMs: timeoutSeconds * 1_000,
    });
    commandFailure("Atlas claim scorer", result);
    const statisticsPath = resolve(scoringDir, `coverage_stats_${model}_all.json`);
    if (!existsSync(statisticsPath)) {
        throw new Error("Atlas claim scorer did not produce coverage statistics.");
    }
    const statistics = JSON.parse(readFileSync(statisticsPath, "utf8")) as {
        readonly valid_responses?: number;
        readonly mean_coverage?: number;
    };
    if (
        statistics.valid_responses !== 1
        || typeof statistics.mean_coverage !== "number"
        || !Number.isFinite(statistics.mean_coverage)
    ) {
        throw new Error("Atlas claim scorer produced invalid coverage statistics.");
    }
    return {
        kind: "claims",
        coverage: statistics.mean_coverage,
        judgeModel,
        sourceRevision: shell("git", ["-C", sourceRoot, "rev-parse", "HEAD"]).trim(),
        dataset: task.oracle.dataset,
    };
};

const main = async (): Promise<void> => {
    process.loadEnvFile(resolve(benchRoot, ".env.defaults"));
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: {
            task: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
    });
    if (positionals.length > 1) {
        throw new Error("Atlas benchlet accepts at most one model alias.");
    }

    const taskName = values.task ?? required("PLURNK_BENCH_ATLAS_TASK");
    const { path: selectedTaskPath, task } = readTask(taskName);
    const model = positionals[0] ?? required("PLURNK_BENCH_ATLAS_MODEL");
    const image = required("PLURNK_BENCH_ATLAS_IMAGE");
    const containerPort = positiveInteger("PLURNK_BENCH_ATLAS_CONTAINER_PORT");
    const listTimeoutMs = positiveInteger("PLURNK_BENCH_ATLAS_LIST_TIMEOUT_MS");
    const toolTimeoutMs = positiveInteger("PLURNK_BENCH_ATLAS_TOOL_TIMEOUT_MS");
    const readyPollMs = positiveInteger("PLURNK_BENCH_ATLAS_READY_POLL_MS");
    const readyRequestTimeoutMs = positiveInteger("PLURNK_BENCH_ATLAS_READY_REQUEST_TIMEOUT_MS");
    const candidateTimeout = positiveInteger("PLURNK_BENCH_ATLAS_CANDIDATE_TIMEOUT_SEC");
    const candidateOverhead = positiveInteger("PLURNK_BENCH_ATLAS_CANDIDATE_OVERHEAD_SEC");
    const maxTurns = positiveInteger("PLURNK_BENCH_ATLAS_MAX_TURNS");
    const filesItems = integer("PLURNK_BENCH_ATLAS_FILES_ITEMS");
    if (filesItems < -1) {
        throw new Error("PLURNK_BENCH_ATLAS_FILES_ITEMS must be -1, 0, or a positive integer.");
    }
    const requiemEnabled = required("PLURNK_BENCH_ATLAS_REQUIEM") === "1";
    const requiemModel = required("PLURNK_BENCH_ATLAS_REQUIEM_MODEL");
    const requiemTimeout = positiveInteger("PLURNK_BENCH_ATLAS_REQUIEM_TIMEOUT_SEC");
    const sourceRepository = required("PLURNK_BENCH_ATLAS_SOURCE_REPOSITORY");
    const sourceRevision = required("PLURNK_BENCH_ATLAS_SOURCE_REVISION");
    if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
        throw new Error("PLURNK_BENCH_ATLAS_SOURCE_REVISION must be a full Git commit.");
    }
    const sourceRoot = resolveFrom(benchRoot, required("PLURNK_BENCH_ATLAS_SOURCE_CACHE"));
    const scorerTimeout = positiveInteger("PLURNK_BENCH_ATLAS_SCORER_TIMEOUT_SEC");
    const judgeModel = required("PLURNK_BENCH_ATLAS_JUDGE_MODEL");
    const judgeConcurrency = positiveInteger("PLURNK_BENCH_ATLAS_JUDGE_CONCURRENCY");
    const passCoverage = ratio("PLURNK_BENCH_ATLAS_PASS_COVERAGE");
    const operatorEnv = expandHome(required("PLURNK_BENCH_ATLAS_OPERATOR_ENV"));
    const runsRoot = resolveFrom(benchRoot, required("PLURNK_BENCH_ATLAS_RUNS_ROOT"));
    const serviceRoot = resolveFrom(benchRoot, required("PLURNK_BENCH_ATLAS_SERVICE_ROOT"));
    const clientRoot = requiredClientCheckout(
        benchRoot,
        process.env,
        "PLURNK_BENCH_ATLAS_CLIENT_ROOT",
    );
    const policy = resolve(serviceRoot, "plurnk-meta", "PLURNK_PERSONALITY.md");
    if (requiemEnabled && !existsSync(operatorEnv)) {
        throw new Error(`Atlas requiem environment is missing: ${operatorEnv}`);
    }
    if (!existsSync(policy)) throw new Error(`Candidate personality is missing: ${policy}`);
    if (task.oracle.kind === "claims") {
        ensureAtlasSource(sourceRepository, sourceRevision, sourceRoot);
    }

    const sources = {
        bench: sourceProvenance(benchRoot),
        service: sourceProvenance(serviceRoot),
        client: sourceProvenance(clientRoot),
        ...(task.oracle.kind === "claims"
            ? { atlas: sourceProvenance(sourceRoot) }
            : {}),
    };
    for (const [name, source] of Object.entries(sources)) {
        if (!source.clean) {
            throw new Error(`${name} source is dirty; commit the exact source before an Atlas run.`);
        }
    }

    const runDir = allocateRunDirectory(runsRoot, ["atlas", task.name, model]);
    activeRunDir = runDir;
    activeStartedAt = new Date();
    copyFileSync(selectedTaskPath, resolve(runDir, "task.json"));
    copyFileSync(policy, resolve(runDir, "candidate-policy.md"));

    activeStage = "image";
    const resolvedImageId = imageId(image);
    writeJson(resolve(runDir, "provenance.json"), {
        schemaVersion: 1,
        state: "running",
        startedAt: activeStartedAt.toISOString(),
        invocation: {
            command: relative(benchRoot, resolve(moduleDir, "benchlet.sh")),
            args: ["--task", task.name, model],
            cwd: benchRoot,
        },
        task,
        model,
        sources,
        webMaterialization: webMaterializationProvenance(process.env),
        image: {
            reference: image,
            id: resolvedImageId,
        },
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        configuration: {
            containerPort,
            listTimeoutMs,
            toolTimeoutMs,
            readyPollMs,
            readyRequestTimeoutMs,
            candidateTimeoutSeconds: candidateTimeout,
            candidateOverheadSeconds: candidateOverhead,
            maxTurns,
            filesItems,
            requiemEnabled,
            requiemModel,
            requiemTimeoutSeconds: requiemTimeout,
            scorerTimeoutSeconds: scorerTimeout,
            judgeModel,
            judgeConcurrency,
            passCoverage,
            credentialKeys: environmentKeyNames(process.env),
        },
    });

    activeStage = "sandbox";
    const started = startContainer(image, containerPort, runDir);
    activeContainer = started.container;
    const tools = await awaitAtlas(
        started.sandboxUrl,
        listTimeoutMs,
        readyPollMs,
        readyRequestTimeoutMs,
    );
    writeJson(resolve(runDir, "atlas-tools.json"), tools);
    const missingTools = missingAtlasTools(tools, task.enabledTools);
    if (missingTools.length > 0) {
        activeStage = "skip";
        captureContainerLog(started.container, runDir);
        removeContainer(started.container);
        activeContainer = undefined;
        const completedAt = new Date();
        writeJson(resolve(runDir, "result.json"), {
            schemaVersion: 2,
            harnessStatus: "skipped",
            passed: null,
            task: task.name,
            model,
            reason: {
                code: "atlas-task-tools-unavailable",
                detail: "The pinned Atlas fixture did not expose every tool enabled for this task.",
                missingTools,
            },
            startedAt: activeStartedAt.toISOString(),
            completedAt: completedAt.toISOString(),
            durationMs: completedAt.getTime() - activeStartedAt.getTime(),
        });
        const provenance = JSON.parse(
            readFileSync(resolve(runDir, "provenance.json"), "utf8"),
        ) as Record<string, unknown>;
        writeJson(resolve(runDir, "provenance.json"), {
            ...provenance,
            state: "skipped",
            completedAt: completedAt.toISOString(),
        });
        process.stdout.write(`artifact=${runDir}\n`);
        return;
    }

    activeStage = "build";
    await buildSource("service", serviceRoot, runDir);
    await buildSource("client", clientRoot, runDir);

    const adapterPath = resolve(moduleDir, "server.ts");
    const adapterArgs = [
        adapterPath,
        "--sandbox-url",
        started.sandboxUrl,
        "--enabled-tools",
        JSON.stringify(task.enabledTools),
        "--list-timeout-ms",
        String(listTimeoutMs),
        "--tool-timeout-ms",
        String(toolTimeoutMs),
    ];
    const candidateEnvironmentOverrides = {
        PLURNK_CANDIDATE_DIR: runDir,
        PLURNK_CANDIDATE_MODEL: model,
        PLURNK_CANDIDATE_SKIP_BUILD: "1",
        PLURNK_CLIENT_CHECKOUT: clientRoot,
        PLURNK_SERVICE_POLICY: resolve(runDir, "candidate-policy.md"),
        PLURNK_SERVICE_EMBED_DISABLE: "1",
        PLURNK_CANDIDATE_CLIENT_ENV: JSON.stringify({
            PLURNK_EXECS_ONLY: "atlas",
        }),
        PLURNK_MCP_ATLAS: process.execPath,
        PLURNK_MCP_ATLAS_ARGS: JSON.stringify(adapterArgs),
    };
    const candidateArgs = [
        "scripts/candidate.mjs",
        ...atlasClientArgs({
            filesItems,
            maxTurns,
            timeoutSeconds: candidateTimeout,
            prompt: task.prompt,
        }),
    ];
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
            ...withoutMcpServers(process.env),
            ...candidateEnvironmentOverrides,
        },
        stdoutPath: resolve(runDir, "candidate.stdout.log"),
        stderrPath: resolve(runDir, "candidate.stderr.log"),
        tee: true,
        timeoutMs: (candidateTimeout + candidateOverhead) * 1_000,
    });

    activeStage = "evaluate";
    const digestPath = resolve(runDir, "digest", "digest.json");
    const digestMarkdownPath = resolve(runDir, "digest", "digest.md");
    if (!existsSync(digestPath) || !existsSync(digestMarkdownPath)) {
        throw new Error("Atlas candidate did not produce a complete digest.");
    }
    const digest = JSON.parse(readFileSync(digestPath, "utf8")) as Digest;
    const loop = digest.loops.find((candidateLoop) => candidateLoop.prompt === task.prompt);
    if (loop === undefined) throw new Error("Atlas digest omitted the task loop.");
    const answer = loop.terminal_message ?? "";
    const successfulAtlasExecs = successfulExecutorCalls(
        digest.log_entries,
        "atlas",
        task.enabledTools,
    );
    const usedAtlas = successfulAtlasExecs > 0;
    const evaluation = task.oracle.kind === "exact"
        ? {
            kind: "exact" as const,
            expectedAnswer: task.oracle.answer,
            matched: answerMatches(answer, task.oracle.answer),
        }
        : await scoreClaims(
            task as AtlasTask & { readonly oracle: ClaimsOracle },
            answer,
            model,
            sourceRoot,
            runDir,
            scorerTimeout,
            judgeModel,
            judgeConcurrency,
        );
    const oraclePassed = evaluation.kind === "exact"
        ? evaluation.matched
        : evaluation.coverage >= passCoverage;
    const successfulExecs = digest.log_entries.filter((entry) =>
        entry.origin === "model"
        && entry.op === "EXEC"
        && entry.status_rx < 400).length;
    const passed = candidate.status === 0
        && loop.status === 200
        && usedAtlas
        && oraclePassed;

    activeStage = "requiem";
    const requiem = await runRequiem(
        requiemEnabled,
        requiemModel,
        requiemTimeout,
        operatorEnv,
        serviceRoot,
        runDir,
    );
    const requiemComplete = !requiemEnabled || requiem.complete === true;

    activeStage = "finalize";
    captureContainerLog(started.container, runDir);
    removeContainer(started.container);
    activeContainer = undefined;
    const completedAt = new Date();
    writeJson(resolve(runDir, "result.json"), {
        schemaVersion: 2,
        harnessStatus: requiemComplete ? "complete" : "incomplete",
        passed,
        task: task.name,
        model,
        answer,
        evaluation,
        passCoverage: evaluation.kind === "claims" ? passCoverage : null,
        oraclePassed,
        usedAtlas,
        successfulExecs,
        successfulAtlasExecs,
        candidate: {
            status: candidate.status,
            signal: candidate.signal,
            timedOut: candidate.timedOut,
            error: candidate.error?.message ?? null,
        },
        loop: {
            status: loop.status,
            result: loop.result ?? null,
        },
        usage: usageSummary(digest),
        requiem,
        startedAt: activeStartedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - activeStartedAt.getTime(),
    });
    const provenance = JSON.parse(
        readFileSync(resolve(runDir, "provenance.json"), "utf8"),
    ) as Record<string, unknown>;
    writeJson(resolve(runDir, "provenance.json"), {
        ...provenance,
        state: "complete",
        completedAt: completedAt.toISOString(),
    });
    process.stdout.write(`artifact=${runDir}\n`);
    if (!passed || !requiemComplete) process.exitCode = 1;
};

if (import.meta.main) {
    void main().catch((error) => {
        const rendered = error instanceof Error
            ? error.stack ?? error.message
            : String(error);
        process.stderr.write(`${rendered}\n`);
        if (activeContainer !== undefined) {
            if (activeRunDir !== undefined) {
                captureContainerLog(activeContainer, activeRunDir);
            }
            removeContainer(activeContainer);
            activeContainer = undefined;
        }
        if (activeRunDir !== undefined) {
            const completedAt = new Date();
            writeFileSync(
                resolve(activeRunDir, "infrastructure-error.log"),
                `${rendered}\n`,
            );
            writeJson(resolve(activeRunDir, "result.json"), {
                schemaVersion: 2,
                harnessStatus: "infrastructure_error",
                stage: activeStage,
                message: error instanceof Error ? error.message : String(error),
                startedAt: activeStartedAt?.toISOString() ?? null,
                completedAt: completedAt.toISOString(),
                durationMs: activeStartedAt === undefined
                    ? null
                    : completedAt.getTime() - activeStartedAt.getTime(),
            });
            process.stderr.write(`artifact=${activeRunDir}\n`);
        }
        process.exitCode = 1;
    });
}
