// SPEC §swebench. The family runner: drive one pinned SWE-bench Lite instance through the
// ordinary plurnk client/service boundary and grade the candidate's patch with the
// benchmark's OWN official evaluator (swebench/evaluate.ts).
//
// Architecture, mirroring deepswe/benchlet.ts's candidate stage: the plurnk daemon and client
// run on the HOST, so the daemon reaches the model endpoint normally; the model's shell
// commands are forwarded by PATH shims (swebench/exec.ts) INTO one long-lived container of
// the instance's eval image (manifest.environment.network, normally `none`), where the
// candidate repository is mounted at its own host path and at `/testbed` — the path the
// image's editable install points at, so the model's own tests import its edits. The oracle
// then grades in its own fresh container.
//
// The trial directory is the Pier-shaped layout the shared core reads:
//   result.json            provenance (trial_name, task_name, model) — src/ingest.ts §provenance
//   agent/plurnk.json      the client's `--json` document
//   agent/plurnk.db        the daemon database
//   artifacts/model.patch  the candidate's diff, start HEAD..worktree
//   verifier/reward.json   the official evaluator's translated verdict (evaluate.ts)
// so src/ingest.ts joins it and src/publish.ts publishes it unchanged.
//
// usage: swebench/run.sh --instance <id> [--model <alias>] [--timeout <s>] [--preflight] [--skip-grading]

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { finished } from "node:stream/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import CandidateContainer from "../src/candidate-container.ts";
import { requiredClientCheckout } from "../src/client-checkout.ts";
import { benchmarksHome, jobsRoot, loadBenchmarkEnvironment, selectedModel } from "../src/host-paths.ts";
import { publishTrial } from "../src/publish.ts";
import { EXECUTOR_SHIMS, writeExecutorShims } from "./exec.ts";
import { candidateIsolation } from "../src/candidate-isolation.ts";

const DATASET = "SWE-bench/SWE-bench_Lite";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");

interface Manifest {
    readonly instance: string;
    readonly datasetRevision?: string;
    readonly repo: string;
    readonly baseCommit: string;
    readonly environment: { readonly kind: string; readonly image: string; readonly network: string; readonly cpus: number; readonly memoryMb: number };
    readonly budgetSeconds: number;
    readonly turnCap?: number;
    readonly problemStatement: string;
}

interface CommandResult {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly error?: Error;
}

// {§swebench-prompt}
export const taskPrompt = (problemStatement: string): string => [
    "Fix the following issue in the checked-out repository.",
    "",
    "<issue>",
    problemStatement.trim(),
    "</issue>",
    "",
    "Implement the fix in the working tree and verify the affected behavior.",
].join("\n");

// {§swebench-conditions} {§swebench-profiles} — ordinary client invocation, stated disposition,
// and the study's turn cap as the bound.
export const candidateArgv = (
    repository: string,
    timeout: number,
    instruction: string,
    turnCap: number,
): string[] => [
    "scripts/candidate.mjs",
    "--json",
    "--auto",
    "--proposals", "accept",
    "--max-turns", String(turnCap),
    "--project-root", repository,
    ...(timeout === -1 ? [] : ["--timeout", String(timeout)]),
    "--", instruction,
];

// The client writes its complete `--json` document as one line; the candidate wrapper's own
// digest output follows it. Recover the last line that is a schema-carrying client document.
export interface CandidateExit {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly error?: Error;
}

export interface ExceptionInfo {
    readonly exception_type: string;
    readonly exception_message: string;
}

// §swebench-trial. A trial's result.json says how the candidate ended. Only a clean exit is `null`:
// a spawn failure and a non-zero exit used to read as success here, so a run that never started
// looked the same as one that finished and simply wrote no patch (#40).
export const exceptionInfo = (result: CandidateExit, timeoutSeconds: number): ExceptionInfo | null => {
    if (result.timedOut) return { exception_type: "AgentTimeoutError", exception_message: `the client exceeded ${timeoutSeconds}s` };
    if (result.error !== undefined) return { exception_type: "AgentSpawnError", exception_message: result.error.message };
    if (result.status !== 0) return { exception_type: "AgentExitError", exception_message: `the client exited ${result.status ?? result.signal ?? "unknown"}` };
    return null;
};

export const extractPlurnkDoc = (text: string): string | null => {
    const lines = text.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index].trim();
        if (!line.startsWith("{")) continue;
        try {
            const value = JSON.parse(line) as { schemaVersion?: unknown };
            if (typeof value === "object" && value !== null && Number.isInteger(value.schemaVersion)) return line;
        } catch {
            // not a JSON line: the wrapper's digest output
        }
    }
    return null;
};

const shell = (
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

const git = (repository: string, args: string[], options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean } = {}): string =>
    shell("git", ["-C", repository, ...args], options);

const writeJson = (path: string, value: unknown): void => {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

// The eval images are 2-4 GB each. Nothing is deleted behind the operator's back ({§swebench});
// the run refuses loudly when the disk cannot hold another image, and prunes only when asked.
const requireDiskRoom = (): void => {
    const minimumGb = Number(process.env.PLURNK_SWEBENCH_MIN_FREE_GB ?? 15);
    if (!Number.isFinite(minimumGb) || minimumGb < 0) throw new Error("PLURNK_SWEBENCH_MIN_FREE_GB must be a non-negative number");
    if (minimumGb === 0) return;
    const root = shell("docker", ["info", "--format={{.DockerRootDir}}"]).trim();
    const free = statfsSync(root.length > 0 ? root : "/");
    const freeGb = (free.bavail * free.bsize) / 1024 ** 3;
    if (freeGb < minimumGb) {
        throw new Error(`${root || "/"} has ${freeGb.toFixed(1)} GB free; a SWE-bench eval image needs several GB. Free space, point Docker elsewhere, or lower PLURNK_SWEBENCH_MIN_FREE_GB.`);
    }
};

const pruneImage = (image: string): void => {
    if (process.env.PLURNK_SWEBENCH_PRUNE_IMAGE !== "1") return;
    shell("docker", ["image", "rm", image], { allowFailure: true });
};

const dockerImageId = (image: string): string => {
    const inspect = spawnSync("docker", ["image", "inspect", "--format={{.Id}}", image], { encoding: "utf8" });
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

const runToFiles = async (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdoutPath: string; stderrPath: string; tee?: boolean; timeoutMs?: number; signal?: AbortSignal },
): Promise<CommandResult> => {
    options.signal?.throwIfAborted();
    const stdout = createWriteStream(options.stdoutPath);
    const stderr = createWriteStream(options.stderrPath);
    const child = spawn(command, args, {
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
    let timedOut = false;
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
    }, options.timeoutMs);
    child.once("error", (error) => { processError = error; });
    const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((accept) => {
        child.once("close", (status, childSignal) => {
            if (timer !== undefined) clearTimeout(timer);
            accept({ status, signal: childSignal });
        });
    });
    await Promise.all([finished(stdout), finished(stderr)]);
    return { ...result, timedOut, ...(processError === undefined ? {} : { error: processError }) };
};

// The image's /testbed is the instance checkout (SWE-bench's environment commit on top of the
// dataset base). Copy it out, mark it as the candidate repository, and record its HEAD — the
// reference the candidate patch is taken against, exactly the state the oracle resets to.
const prepareRepository = (manifest: Manifest, destination: string): string => {
    mkdirSync(destination, { recursive: true });
    const container = shell("docker", ["create", manifest.environment.image]).trim();
    try {
        shell("docker", ["cp", `${container}:/testbed/.`, destination]);
    } finally {
        removeContainer(container);
    }
    git(destination, ["config", "core.fileMode", "false"]);
    git(destination, ["config", "core.hooksPath", "/dev/null"]);
    git(destination, ["config", "user.name", "Plurnk"]);
    git(destination, ["config", "user.email", "plurnk@pm.me"]);
    return git(destination, ["rev-parse", "HEAD"]).trim();
};

// The graded patch is the candidate's whole working state against its start HEAD (committed and
// uncommitted alike), taken through an alternate index so the repository's own index is
// untouched — exactly the diff the official evaluator applies inside its fresh container.
const capturePatch = (repository: string, startCommit: string, trialDir: string): string => {
    const artifacts = join(trialDir, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const patchPath = join(artifacts, "model.patch");
    const alternateIndex = join(trialDir, "working.index");
    const indexEnv = { ...process.env, GIT_INDEX_FILE: alternateIndex };
    git(repository, ["read-tree", "HEAD"], { env: indexEnv });
    git(repository, ["add", "-A"], { env: indexEnv });
    const diff = spawnSync("git", ["-C", repository, "diff", "--cached", "--binary", startCommit, "--"], { env: indexEnv, encoding: "buffer", maxBuffer: 1 << 30 });
    if (diff.error !== undefined) throw diff.error;
    if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr?.toString().trim() ?? ""}`);
    writeFileSync(patchPath, diff.stdout);
    rmSync(alternateIndex, { force: true });
    return patchPath;
};

const main = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    loadBenchmarkEnvironment(process.env.PLURNK_SWEBENCH_OPERATOR_ENV, resolve(benchRoot, ".env.defaults"));
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            instance: { type: "string" },
            model: { type: "string" },
            timeout: { type: "string" },
            preflight: { type: "boolean", default: false },
            "skip-grading": { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });
    const instance = values.instance;
    if (instance === undefined || instance.trim() === "") throw new Error("swebench runner requires --instance <id>");
    const manifestPath = resolve(moduleDir, "manifests", `${instance}.json`);
    if (!existsSync(manifestPath)) throw new Error(`no pinned SWE-bench Lite manifest for ${instance}; run: node swebench/pin-task.mjs ${instance}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (manifest.instance !== instance) throw new Error(`manifest ${manifestPath} does not name ${instance}`);
    const model = values.model ?? selectedModel();
    const timeout = values.timeout === undefined
        ? (process.env.PLURNK_SWEBENCH_TIMEOUT_SEC === undefined ? manifest.budgetSeconds - 120 : Number(process.env.PLURNK_SWEBENCH_TIMEOUT_SEC))
        : Number(values.timeout);
    if (!Number.isSafeInteger(timeout) || timeout === 0 || timeout < -1) throw new Error("--timeout must be a positive integer, or -1 for no limit");
    const overhead = Number(process.env.PLURNK_SWEBENCH_OVERHEAD_SEC ?? 900);
    if (!Number.isSafeInteger(overhead) || overhead <= 0) throw new Error("PLURNK_SWEBENCH_OVERHEAD_SEC must be a positive integer");

    const scratchRoot = jobsRoot("swebench");
    mkdirSync(scratchRoot, { recursive: true });
    const trialDir = mkdtempSync(resolve(scratchRoot, `${instance.replaceAll(/[^A-Za-z0-9_.-]+/g, "-")}-`));
    const repository = join(trialDir, "repo");

    requireDiskRoom();
    const imageId = dockerImageId(manifest.environment.image);
    const startHead = prepareRepository(manifest, repository);

    const candidateContainer = new CandidateContainer((command, args, options) => shell(command, args, options));
    const user = process.getuid!() + ":" + process.getgid!();
    const container = candidateContainer.start(manifest.environment, repository, user, "/testbed");
    try {
        const binDir = join(trialDir, "bin");
        writeExecutorShims(binDir, { container, repository, user, home: candidateContainer.home!, realPath: process.env.PATH ?? "" });
        writeJson(join(trialDir, "candidate-execution.json"), candidateContainer.record(manifest.environment, repository, EXECUTOR_SHIMS, "/testbed"));

        if (values.preflight) {
            // The image's own toolchain, not one instance's dependency: every SWE-bench image
            // installs its repository into the testbed environment, so importing it proves the shim
            // reaches the right interpreter for any instance (#40).
            const probe = spawnSync("docker", ["exec", "-u", user, "-w", repository, "-e", `HOME=${candidateContainer.home!}`, container, "bash", "-lc",
                "python -c \"import sys; print(sys.executable)\" && git -C \"$PWD\" rev-parse HEAD"], { encoding: "utf8" });
            writeJson(join(trialDir, "preflight.json"), {
                status: probe.status === 0 ? "ready" : "failed",
                instance,
                model,
                dataset: DATASET,
                image: manifest.environment.image,
                imageId,
                network: manifest.environment.network,
                startHead,
                baseCommit: manifest.baseCommit,
                repository,
                executors: EXECUTOR_SHIMS,
                gitStatus: git(repository, ["status", "--porcelain"]),
                probe: { status: probe.status, stdout: probe.stdout.trim(), stderr: probe.stderr.trim() },
            });
            process.stdout.write(`ready=${trialDir}\n`);
            return;
        }

        const clientRoot = requiredClientCheckout(benchRoot, process.env, "PLURNK_SWEBENCH_CLIENT_ROOT");
        const serviceRoot = resolve(benchRoot, process.env.PLURNK_SWEBENCH_SERVICE_ROOT ?? "../plurnk-service");
        if (!existsSync(join(serviceRoot, "scripts", "candidate.mjs"))) throw new Error(`service checkout has no scripts/candidate.mjs: ${serviceRoot}`);

        const agentDir = join(trialDir, "agent");
        mkdirSync(agentDir, { recursive: true });
        // {§benchlet-isolation} — the candidate reaches no network beyond its model:
        // the operator's MCP/A2A definitions are masked, search credentials blanked,
        // and the daemon's web schemes admit no host.
        const isolation = candidateIsolation(Object.keys(process.env));
        writeJson(join(trialDir, "candidate-isolation.json"), { masked: isolation.masked, webHosts: [], capabilities: isolation.capabilities });
        const candidateEnv: NodeJS.ProcessEnv = {
            ...process.env,
            PATH: binDir + ":" + (process.env.PATH ?? ""),
            PLURNK_CANDIDATE_DIR: agentDir,
            PLURNK_MODEL: model,
            PLURNK_CLIENT_CHECKOUT: clientRoot,
            PLURNK_EXECS_QUESTION: "0",
            ...isolation.overrides,
        };
        const stdoutPath = join(agentDir, "plurnk.stdout.log");
        const startedAt = new Date();
        const result = await runToFiles(process.execPath, candidateArgv(repository, timeout, taskPrompt(manifest.problemStatement), manifest.turnCap ?? 100), {
            cwd: serviceRoot,
            env: candidateEnv,
            stdoutPath,
            stderrPath: join(agentDir, "plurnk.stderr.log"),
            tee: true,
            ...(timeout === -1 ? {} : { timeoutMs: (timeout + overhead) * 1000 }),
            signal,
        });
        const finishedAt = new Date();
        candidateContainer.stop();

        const docLine = extractPlurnkDoc(readFileSync(stdoutPath, "utf8"));
        if (docLine === null) throw new Error(`the plurnk client left no JSON document in ${stdoutPath}`);
        writeFileSync(join(agentDir, "plurnk.json"), `${docLine}\n`);
        if (!existsSync(join(agentDir, "plurnk.db"))) throw new Error(`the candidate daemon wrote no database in ${agentDir}`);
        const patchPath = capturePatch(repository, startHead, trialDir);

        writeJson(join(trialDir, "result.json"), {
            schemaVersion: 2,
            trial_name: `${model}-${manifest.instance}`,
            task_name: manifest.instance,
            config: { agent: { model_name: model } },
            started_at: startedAt.toISOString(),
            finished_at: finishedAt.toISOString(),
            exception_info: exceptionInfo(result, timeout),
        });

        const provenance = {
            schemaVersion: 1,
            instance: manifest.instance,
            model,
            dataset: DATASET,
            datasetRevision: manifest.datasetRevision ?? null,
            image: manifest.environment.image,
            imageId,
            startHead,
            baseCommit: manifest.baseCommit,
            timeoutSeconds: timeout,
            repository,
            // {§swebench-prompt}: the framing is a harness choice, so it is declared per trial.
            taskPrompt: taskPrompt(manifest.problemStatement),
            candidate: { status: result.status, signal: result.signal, timedOut: result.timedOut },
        };
        // The published trial carries its provenance: written before publication, never after (#40).
        writeJson(join(trialDir, "provenance.json"), provenance);

        let runDir: string | null = null;
        if (values["skip-grading"] !== true) {
            // The verifier half is an ordinary subprocess; it resolves the shared core
            // through the installed package's published (dist) exports, not plurnk-dev.
            const graded = spawnSync(process.execPath, [join(moduleDir, "evaluate.ts"), "--instance", manifest.instance, "--patch", patchPath, "--out", trialDir, "--label", "plurnk"], { cwd: benchRoot, stdio: "inherit", env: process.env });
            if (graded.status !== 0) throw new Error(`the official evaluator exited ${graded.status ?? graded.signal ?? "unknown"}`);
            runDir = await publishTrial(trialDir, "swebench", benchmarksHome());
        }
        writeJson(join(trialDir, "provenance.json"), { ...provenance, runDir });
        process.stdout.write(`artifact=${trialDir}\n`);
        if (runDir !== null) process.stdout.write(`published=${runDir}\n`);
    } finally {
        candidateContainer.stop();
        pruneImage(manifest.environment.image);
    }
};

if (import.meta.main) {
    const interruption = new AbortController();
    process.once("SIGINT", () => interruption.abort(new Error("swebench runner interrupted by SIGINT")));
    process.once("SIGTERM", () => interruption.abort(new Error("swebench runner interrupted by SIGTERM")));
    void main(interruption.signal).catch((error) => {
        const rendered = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`${rendered}\n`);
        process.exitCode = 1;
    });
}
