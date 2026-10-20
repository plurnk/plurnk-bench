// {§bughunt-trial} Bug Hunt Bench runner: drives one or both legs through plurnk client/daemon
// and publishes the trial according to the platform canon (SPEC §publish / §results-canon).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { benchmarksHome, jobsRoot, loadBenchmarkEnvironment, selectedModel } from "../src/host-paths.ts";
import { candidateIsolation } from "../src/candidate-isolation.ts";
import { allocateRunDirectory } from "../src/run-directory.ts";
import { publishTrial, runLabelsFor } from "../src/publish.ts";
import {
    candidateArgv,
    captureBugsFound,
    capturePatch,
    exceptionInfo,
    extractPlurnkDoc,
    loadTaskPrompt,
    prepareRepository,
    runToFiles,
    type BugHuntTask,
    type CandidateExit,
} from "./candidate.ts";
import {
    parseScoreJson,
    translateScoreToReward,
    verifyRepoHealth,
    writeEvaluation,
    type BugHuntEvaluation,
    type BugHuntScore,
} from "./evaluator.ts";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");

export interface RunLegOptions {
    readonly task: BugHuntTask;
    readonly sourceRepo: string;
    readonly model: string;
    readonly effort?: string;
    readonly turnCap: number;
    readonly timeout: number;
    readonly preflight?: boolean;
    readonly skipGrading?: boolean;
    readonly scoreJson?: string;
    readonly mockScore?: number;
    readonly noPublish?: boolean;
    readonly signal?: AbortSignal;
}

export interface LegResult {
    readonly task: BugHuntTask;
    readonly trialDir: string;
    readonly publishedDir: string | null;
    readonly exit: CandidateExit;
    readonly score?: BugHuntScore;
}

// {§bughunt-trial} Run one Bug Hunt task leg (repo1 or repo2)
export const runLeg = async (options: RunLegOptions): Promise<LegResult> => {
    options.signal?.throwIfAborted();
    const { task, sourceRepo, model, turnCap, timeout } = options;

    const scratchRoot = jobsRoot("bughunt");
    mkdirSync(scratchRoot, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trialDir = mkdtempSync(resolve(scratchRoot, `${task}-${stamp}-`));
    process.stdout.write(`artifact=${trialDir}\n`);

    const workRepo = join(trialDir, "repo");
    let startHead = "";

    if (!options.preflight) {
        if (!existsSync(sourceRepo)) {
            throw new Error(`Bug Hunt source repository for '${task}' does not exist: ${sourceRepo}`);
        }
        startHead = prepareRepository(sourceRepo, workRepo);
    } else {
        mkdirSync(workRepo, { recursive: true });
    }

    const runDir = options.preflight || options.noPublish
        ? null
        : allocateRunDirectory(benchmarksHome(), runLabelsFor("bughunt", task, model));
    const agentDir = runDir ?? join(trialDir, "agent");

    if (runDir === null) {
        mkdirSync(agentDir, { recursive: true });
    } else {
        symlinkSync(runDir, join(trialDir, "agent"));
        process.stdout.write(`run=${runDir}\n`);
    }

    // {§bughunt-isolation} Mask ambient MCP, A2A, and external web schemes
    const isolation = candidateIsolation(Object.keys(process.env));
    const candidateEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PLURNK_SERVICE_DB_PATH: join(agentDir, "plurnk.db"),
        PLURNK_EXECS_QUESTION: "0",
        PLURNK_SERVICE_POLICY: "",
        PLURNK_SERVICE_PACKET_INJECT: "",
        PLURNK_SERVICE_ROOTS: "project",
        ...(options.effort ? { [`PLURNK_PROVIDERS_EFFORT_${model}`]: options.effort } : {}),
        ...isolation.overrides,
    };

    writeFileSync(
        join(trialDir, "candidate-isolation.json"),
        JSON.stringify({ masked: isolation.masked, capabilities: isolation.capabilities }, null, 2),
    );

    const prompt = loadTaskPrompt(task);
    const argv = candidateArgv(workRepo, prompt, {
        turnCap,
        timeout,
        model,
        effort: options.effort,
    });

    const stdoutPath = join(agentDir, "plurnk.stdout.log");
    const stderrPath = join(agentDir, "plurnk.stderr.log");
    const startedAt = new Date();

    if (options.preflight) {
        process.stdout.write(`ready=${trialDir}\n`);
        return {
            task,
            trialDir,
            publishedDir: null,
            exit: { status: 0, signal: null, timedOut: false },
        };
    }

    const exit = await runToFiles(argv[0], argv.slice(1), {
        cwd: workRepo,
        env: candidateEnv,
        stdoutPath,
        stderrPath,
        timeoutMs: timeout === -1 ? undefined : (timeout + 300) * 1000,
        signal: options.signal,
    });
    const finishedAt = new Date();

    const stdoutText = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
    const docLine = extractPlurnkDoc(stdoutText);
    if (docLine !== null) {
        writeFileSync(join(agentDir, "plurnk.json"), `${docLine}\n`);
    }

    const patchPath = capturePatch(workRepo, startHead, trialDir);
    captureBugsFound(workRepo, trialDir);

    writeFileSync(
        join(trialDir, "result.json"),
        JSON.stringify(
            {
                schemaVersion: 2,
                trial_name: `${model}-${task}`,
                task_name: task,
                config: { agent: { model_name: model } },
                started_at: startedAt.toISOString(),
                finished_at: finishedAt.toISOString(),
                exception_info: exceptionInfo(exit, timeout),
            },
            null,
            2,
        ) + "\n",
    );

    const provenance = {
        schemaVersion: 1,
        benchmark: "bughunt",
        task,
        model,
        effort: options.effort ?? "default",
        startHead,
        timeoutSeconds: timeout,
        turnCap,
        candidate: { status: exit.status, signal: exit.signal, timedOut: exit.timedOut },
        runDir,
    };
    writeFileSync(join(trialDir, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");

    let score: BugHuntScore | undefined;
    if (!options.skipGrading) {
        if (options.mockScore !== undefined) {
            score = {
                fixedOf105: options.mockScore,
                fixedRepo1: task === "repo1" ? options.mockScore : 0,
                fixedRepo2: task === "repo2" ? options.mockScore : 0,
                brokenBuild: false,
            };
        } else if (options.scoreJson !== undefined && existsSync(options.scoreJson)) {
            score = parseScoreJson(readFileSync(options.scoreJson, "utf8"));
        } else {
            const health = verifyRepoHealth(workRepo, task);
            score = {
                brokenBuild: !health.healthy,
                details: health.details,
            };
        }

        const reward = translateScoreToReward(score, task);
        const evaluation: BugHuntEvaluation = {
            task,
            model,
            score,
            reward,
            gradedAt: new Date().toISOString(),
        };
        writeEvaluation(trialDir, evaluation);
    }

    let publishedDir: string | null = null;
    if (!options.noPublish && runDir !== null) {
        publishedDir = await publishTrial(trialDir, "bughunt", benchmarksHome(), { runDir });
        if (publishedDir !== null) {
            process.stdout.write(`published=${publishedDir}\n`);
        }
    }

    return { task, trialDir, publishedDir, exit, score };
};

export const main = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    loadBenchmarkEnvironment(process.env.PLURNK_BUGHUNT_OPERATOR_ENV, resolve(benchRoot, ".env.defaults"));

    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            task: { type: "string", default: "all" },
            repo1: { type: "string" },
            repo2: { type: "string" },
            repo: { type: "string" },
            model: { type: "string" },
            effort: { type: "string" },
            timeout: { type: "string", default: "-1" },
            "turn-cap": { type: "string", default: "1000" },
            preflight: { type: "boolean", default: false },
            "skip-grading": { type: "boolean", default: false },
            "score-json": { type: "string" },
            "mock-score": { type: "string" },
            "no-publish": { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });

    const taskArg = (values.task ?? "all").toLowerCase();
    if (taskArg !== "repo1" && taskArg !== "repo2" && taskArg !== "all") {
        throw new Error(`Invalid --task '${values.task}'; must be repo1, repo2, or all`);
    }

    const model = values.model ?? selectedModel();
    const timeout = Number(values.timeout);
    const turnCap = Number(values["turn-cap"]);
    const mockScore = values["mock-score"] !== undefined ? Number(values["mock-score"]) : undefined;

    const repo1Path = values.repo1 ?? (taskArg === "repo1" ? values.repo : undefined) ?? process.env.PLURNK_BUGHUNT_REPO1;
    const repo2Path = values.repo2 ?? (taskArg === "repo2" ? values.repo : undefined) ?? process.env.PLURNK_BUGHUNT_REPO2;

    const legsToRun: BugHuntTask[] = taskArg === "all" ? ["repo1", "repo2"] : [taskArg];

    for (const leg of legsToRun) {
        const sourceRepo = leg === "repo1" ? repo1Path : repo2Path;
        if (!values.preflight && (!sourceRepo || sourceRepo.trim() === "")) {
            throw new Error(`Missing repository path for ${leg}. Provide --${leg} <path> or PLURNK_BUGHUNT_${leg.toUpperCase()}`);
        }

        const result = await runLeg({
            task: leg,
            sourceRepo: sourceRepo ?? "",
            model,
            effort: values.effort,
            turnCap,
            timeout,
            preflight: values.preflight,
            skipGrading: values["skip-grading"],
            scoreJson: values["score-json"],
            mockScore,
            noPublish: values["no-publish"],
            signal,
        });

        process.stdout.write(`Finished leg ${leg}: trial=${result.trialDir} exit=${result.exit.status}\n`);
    }
};

if (import.meta.main) {
    const interruption = new AbortController();
    process.once("SIGINT", () => interruption.abort(new Error("bughunt runner interrupted by SIGINT")));
    process.once("SIGTERM", () => interruption.abort(new Error("bughunt runner interrupted by SIGTERM")));
    void main(interruption.signal).catch((error) => {
        const rendered = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`${rendered}\n`);
        process.exitCode = 1;
    });
}
