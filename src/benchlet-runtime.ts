import { createHash } from "node:crypto";
import {
    closeSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { finished } from "node:stream/promises";

export interface CommandResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly error?: Error;
}

export interface ContainerExec {
    readonly container: string;
    readonly repository: string;
    readonly user: string;
    readonly home: string;
    readonly realPath: string;
}

const ALIAS_KNOBS = [
    "PLURNK_MODEL",
    "PLURNK_PROVIDERS_EFFORT",
    "PLURNK_PROVIDERS_SERVICE_TIER",
    "PLURNK_PROVIDERS_TEMPERATURE",
    "PLURNK_PROVIDERS_REPEAT_PENALTY",
    "PLURNK_PROVIDERS_CONTEXT_WINDOW",
    "PLURNK_PROVIDERS_OUTPUT_BUDGET",
    "PLURNK_PROVIDERS_REASONING_BUDGET",
] as const;

export const aliasConfiguration = (alias: string, env: NodeJS.ProcessEnv): Record<string, string> =>
    Object.fromEntries(
        ALIAS_KNOBS.map((knob) => [`${knob}_${alias}`, env[`${knob}_${alias}`]]).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    );

export const expandHome = (value: string): string =>
    value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;

export const resolveFrom = (root: string, value: string): string =>
    resolve(root, expandHome(value));

export const candidatePolicyPath = (serviceRoot: string): string =>
    resolve(serviceRoot, "plurnk-meta", "POLICY.md");

export const candidatePolicySnapshotPath = (runDir: string): string =>
    resolve(runDir, "candidate-policy.md");

export const candidateRecapSnapshotPath = (runDir: string): string =>
    resolve(runDir, "candidate-recap.md");

export const sha256 = (path: string): string =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

export const shell = (
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

export const git = (
    repository: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): string => shell("git", ["-C", repository, ...args], options);

export const gitDir = (repository: string, args: string[]): string =>
    shell("git", [`--git-dir=${repository}`, ...args]);

export const dockerImageId = (image: string): string => {
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

export const removeContainer = (container: string): void => {
    shell("docker", ["rm", "--force", container], { allowFailure: true });
};

export const writeJson = (path: string, value: unknown): void => {
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
        signal?: AbortSignal;
    },
): Promise<CommandResult> => {
    options.signal?.throwIfAborted();
    const stdout = createWriteStream(options.stdoutPath);
    const stderr = createWriteStream(options.stderrPath);
    const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        signal: options.signal,
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
    options.signal?.throwIfAborted();
    return result;
};

export const streamGitDiff = async (
    repository: string,
    args: string[],
    path: string,
    env: NodeJS.ProcessEnv = process.env,
    signal?: AbortSignal,
): Promise<void> => {
    signal?.throwIfAborted();
    const fd = openSync(path, "w");
    try {
        const child = spawn("git", ["-C", repository, ...args], {
            env,
            signal,
            stdio: ["ignore", fd, "pipe"],
        });
        let errorText = "";
        let processError: Error | undefined;
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (chunk: string) => {
            errorText += chunk;
        });
        child.once("error", (error) => {
            processError = error;
        });
        const result = await new Promise<CommandResult>((accept) => {
            child.once("close", (status, childSignal) => accept({
                status,
                signal: childSignal,
                timedOut: false,
                ...(processError === undefined ? {} : { error: processError }),
            }));
        });
        signal?.throwIfAborted();
        if (result.error !== undefined) throw result.error;
        if (result.status !== 0) {
            throw new Error(`git diff failed (${result.status ?? result.signal ?? "unknown"}): ${errorText.trim()}`);
        }
    } finally {
        closeSync(fd);
    }
};

// {§benchlet-diagnostic} — the candidate's commands run inside the task image, not on the host.
export const EXECUTOR_SHIMS: readonly string[] = Object.freeze([
    "sh", "bash", "node", "python3", "python", "perl", "ruby", "lua", "deno", "bun", "tclsh", "bc", "awk",
    "jq", "sqlite3", "npm", "npx", "pnpm", "yarn", "cargo", "rustc", "go", "make",
]);

const shq = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
export const executorShim = (name: string, exec: ContainerExec): string => [
    "#!/bin/sh",
    "# {§benchlet-diagnostic} — inside the candidate repository the command runs in the task container",
    "# at the same path; anywhere else it runs on the host.",
    'case "${PWD}/" in',
    "    " + shq(exec.repository + "/") + '*) exec docker exec -i -u ' + shq(exec.user) + ' -w "${PWD}" -e HOME=' + shq(exec.home) + " " + shq(exec.container) + " " + name + ' "$@" ;;',
    "esac",
    "PATH=" + shq(exec.realPath) + " exec " + name + ' "$@"',
    "",
].join("\n");

export const writeExecutorShims = (binDir: string, exec: ContainerExec): void => {
    mkdirSync(binDir, { recursive: true });
    for (const name of EXECUTOR_SHIMS) writeFileSync(resolve(binDir, name), executorShim(name, exec), { mode: 0o755 });
};

export const environmentKeyNames = (env: NodeJS.ProcessEnv): string[] =>
    Object.keys(env)
        .filter((name) => /(?:API_KEY|_TOKEN|BASE_URL)$/.test(name))
        .toSorted();

export const envFileKeyNames = (path: string): string[] => {
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

// {§benchlet-diagnostic} — -1 is the no-limit idiom; the returned undefined means "no timer".
export const candidateTimeoutMs = (
    candidateTimeout: number,
    candidateOverhead: number,
): number | undefined => candidateTimeout === -1
    ? undefined
    : (candidateTimeout + candidateOverhead) * 1_000;

// {§benchlet-diagnostic}
export const candidateOutcome = (exit: CommandResult): "finished" | "timeout" | "spawn_failed" | "exited" => {
    if (exit.timedOut) return "timeout";
    if (exit.error !== undefined) return "spawn_failed";
    if (exit.status !== 0) return "exited";
    return "finished";
};

export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const producedNoPatch = (submissionSha256: string): boolean => submissionSha256 === EMPTY_SHA256;

export const recordInfrastructureFailure = (
    runDir: string,
    stage: string,
    startedAt: Date | undefined,
    error: unknown,
    completedAt = new Date(),
): void => {
    const rendered = error instanceof Error ? error.stack ?? error.message : String(error);
    writeFileSync(resolve(runDir, "infrastructure-error.log"), `${rendered}\n`);
    writeJson(resolve(runDir, "result.json"), {
        schemaVersion: 2,
        harnessStatus: "infrastructure_error",
        infrastructure: {
            stage,
            message: error instanceof Error ? error.message : String(error),
        },
        startedAt: startedAt?.toISOString() ?? null,
        completedAt: completedAt.toISOString(),
        durationMs: startedAt === undefined ? null : completedAt.getTime() - startedAt.getTime(),
    });
    const provenancePath = resolve(runDir, "provenance.json");
    if (!existsSync(provenancePath)) return;
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as Record<string, unknown>;
    writeJson(provenancePath, {
        ...provenance,
        state: "infrastructure_error",
        failedStage: stage,
        completedAt: completedAt.toISOString(),
    });
};

export const requiemModelAlias = (
    enabled: boolean,
    configured: string | undefined,
    candidateModel: string,
): string | null => {
    if (!enabled) return null;
    // {§config-carry}: unset inherits the already-resolved candidate selection.
    return configured?.trim() || candidateModel;
};
