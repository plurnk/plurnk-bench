// {§bughunt-candidate} Bug Hunt Bench candidate invocation and patch capture.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finished } from "node:stream/promises";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export type BugHuntTask = "repo1" | "repo2";

export interface CandidateOptions {
    readonly turnCap?: number;
    readonly timeout?: number;
    readonly model?: string;
    readonly effort?: string;
}

export interface CandidateExit {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly cancelled?: boolean;
    readonly error?: Error;
}

export interface ExceptionInfo {
    readonly exception_type: string;
    readonly exception_message: string;
}

// {§bughunt-prompts} Load the verbatim task prompt from Pawel Huryn's benchmark
export const loadTaskPrompt = (task: BugHuntTask): string => {
    const promptPath = resolve(moduleDir, "prompts", `${task}.md`);
    if (!existsSync(promptPath)) {
        throw new Error(`Bug Hunt prompt not found for task '${task}': ${promptPath}`);
    }
    return readFileSync(promptPath, "utf8").trim();
};

// {§bughunt-candidate} Candidate argv: standard plurnk client invocation with local approval
export const candidateArgv = (
    repository: string,
    prompt: string,
    options: CandidateOptions = {},
): string[] => {
    const turnCap = options.turnCap ?? 1000;
    const timeout = options.timeout ?? -1;
    return [
        "plurnk",
        "--json",
        "--yolo",
        "--max-turns", String(turnCap),
        "--project-root", repository,
        ...(timeout === -1 ? [] : ["--timeout", String(timeout)]),
        ...(options.model ? ["--model", options.model] : []),
        ...(options.effort ? ["--effort", options.effort] : []),
        "--", prompt,
    ];
};

export const shell = (
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): string => {
    const result = spawnSync(command, args, { cwd: options.cwd, env: options.env ?? process.env, encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    if (!options.allowFailure && result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"}): ${result.stderr || result.stdout}`.trim());
    }
    return result.stdout;
};

export const git = (
    repository: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {},
): string => shell("git", ["-C", repository, ...args], options);

// {§bughunt-trial} Exception categorization for candidate termination
export const exceptionInfo = (result: CandidateExit, timeoutSeconds?: number): ExceptionInfo | null => {
    if (result.timedOut) {
        return {
            exception_type: "AgentTimeoutError",
            exception_message: `the client exceeded ${timeoutSeconds ?? "limit"}s`,
        };
    }
    if (result.cancelled) {
        return {
            exception_type: "AgentCancelledError",
            exception_message: result.error?.cause instanceof Error
                ? result.error.cause.message
                : result.error?.message ?? "the client was externally cancelled",
        };
    }
    if (result.error !== undefined) {
        return { exception_type: "AgentSpawnError", exception_message: result.error.message };
    }
    if (result.status !== 0) {
        return {
            exception_type: "AgentExitError",
            exception_message: `the client exited ${result.status ?? result.signal ?? "unknown"}`,
        };
    }
    return null;
};

// Extract the client's --json record line from candidate output
export const extractPlurnkDoc = (text: string): string | null => {
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line.startsWith("{")) continue;
        try {
            const value = JSON.parse(line) as { schemaVersion?: unknown };
            if (typeof value === "object" && value !== null && Number.isInteger(value.schemaVersion)) return line;
        } catch {
            // not a valid JSON line
        }
    }
    return null;
};

// Prepare a disposable workspace checkout with clean git metadata
export const prepareRepository = (sourceDir: string, destinationDir: string): string => {
    mkdirSync(destinationDir, { recursive: true });
    cpSync(sourceDir, destinationDir, { recursive: true });

    // Ensure git repository is initialized at baseline
    if (!existsSync(join(destinationDir, ".git"))) {
        git(destinationDir, ["init"]);
    }
    git(destinationDir, ["config", "core.fileMode", "false"]);
    git(destinationDir, ["config", "core.hooksPath", "/dev/null"]);
    git(destinationDir, ["config", "user.name", "Plurnk"]);
    git(destinationDir, ["config", "user.email", "plurnk@pm.me"]);

    // If there is no commit or untracked changes at baseline, commit them
    const hasCommits = git(destinationDir, ["rev-parse", "--verify", "HEAD"], { allowFailure: true }).trim() !== "";
    if (!hasCommits) {
        git(destinationDir, ["add", "-A"]);
        git(destinationDir, ["commit", "-m", "baseline seeded state"]);
    }
    return git(destinationDir, ["rev-parse", "HEAD"]).trim();
};

// Capture git diff against startCommit using an isolated alternate index
export const capturePatch = (repository: string, startCommit: string, trialDir: string): string => {
    const artifacts = join(trialDir, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const patchPath = join(artifacts, "model.patch");
    const alternateIndex = join(trialDir, "working.index");
    const indexEnv = { ...process.env, GIT_INDEX_FILE: alternateIndex };

    git(repository, ["read-tree", "HEAD"], { env: indexEnv });
    git(repository, ["add", "-A"], { env: indexEnv });
    const diff = spawnSync("git", ["-C", repository, "diff", "--cached", "--binary", startCommit, "--"], {
        env: indexEnv,
        encoding: "buffer",
        maxBuffer: 1 << 30,
    });
    if (diff.error !== undefined) throw diff.error;
    if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr?.toString().trim() ?? ""}`);
    writeFileSync(patchPath, diff.stdout);
    rmSync(alternateIndex, { force: true });
    return patchPath;
};

// Capture BUGS_FOUND.md if produced by the candidate
export const captureBugsFound = (repository: string, trialDir: string): string | null => {
    const bugsFoundPath = join(repository, "BUGS_FOUND.md");
    if (!existsSync(bugsFoundPath)) return null;
    const artifactsDir = join(trialDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    const targetPath = join(artifactsDir, "BUGS_FOUND.md");
    copyFileSync(bugsFoundPath, targetPath);
    return targetPath;
};

// Stream process execution to stdout/stderr log files
export const runToFiles = async (
    command: string,
    args: string[],
    options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        stdoutPath: string;
        stderrPath: string;
        tee?: boolean;
        timeoutMs?: number;
        signal?: AbortSignal;
    },
): Promise<CandidateExit> => {
    options.signal?.throwIfAborted();
    const stdout = createWriteStream(options.stdoutPath);
    const stderr = createWriteStream(options.stderrPath);
    const child: ChildProcess = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.pipe(stdout);
    child.stderr!.pipe(stderr);
    if (options.tee === true) {
        child.stdout!.on("data", (chunk: Buffer) => process.stdout.write(chunk));
        child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    }
    let processError: Error | undefined;
    let cancelled = false;
    let timedOut = false;
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
    }, options.timeoutMs);

    child.once("error", (error) => {
        processError = error;
        cancelled = options.signal?.aborted === true && error.name === "AbortError";
    });

    const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((accept) => {
        child.once("close", (status, childSignal) => {
            if (timer !== undefined) clearTimeout(timer);
            accept({ status, signal: childSignal });
        });
    });
    await Promise.all([finished(stdout), finished(stderr)]);
    return { ...result, timedOut, cancelled, ...(processError === undefined ? {} : { error: processError }) };
};
