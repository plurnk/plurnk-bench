// {§pair-sheet} — one specimen, two harnesses, one sheet. `deepswe/pair.sh --task <task>` runs a
// pinned DeepSWE task once through the plurnk benchlet and once through Pier's mini-swe-agent on
// the same model route, then writes PAIR.md from each harness's own result.json: both oracle
// verdicts and both cost shapes, side by side. The sheet states facts and names no winner; a
// pair is one specimen, never a corpus. Evidence a harness cannot supply is written as absent,
// never as zero.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { jobsRoot, loadBenchmarkEnvironment, selectedModel } from "../src/host-paths.ts";
import MiniTrajectoryReader, { type MiniTrajectory } from "./mini-trajectory.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH_ROOT = resolve(HERE, "..");
export const ROUTES_PATH = resolve(HERE, "pair.aliases.json");

// A plurnk alias's mini-swe-agent equivalent: Pier's `-m` model, the OpenAI-compatible endpoint,
// the NAME of the host variable holding its key (the value is read at spawn and written nowhere),
// and the reasoning effort the alias runs at. Explicit per alias; nothing is derived.
export interface PairRoute {
    readonly model: string;
    readonly baseUrl: string;
    readonly keyEnv: string;
    readonly reasoningEffort: string;
}

const isRoute = (value: unknown): value is PairRoute => {
    if (typeof value !== "object" || value === null) return false;
    const route = value as Record<string, unknown>;
    return ["model", "baseUrl", "keyEnv", "reasoningEffort"].every((key) => typeof route[key] === "string" && (route[key] as string).trim() !== "");
};

export const readRoutes = (path: string): Record<string, PairRoute> => {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    for (const [alias, route] of Object.entries(parsed)) {
        if (!isRoute(route)) throw new TypeError(`${path}: alias ${alias} needs model, baseUrl, keyEnv and reasoningEffort strings`);
    }
    return parsed as Record<string, PairRoute>;
};

export const routeFor = (routes: Record<string, PairRoute>, alias: string): PairRoute => {
    const route = routes[alias];
    if (route === undefined) throw new Error(`pair has no mini-swe-agent route for alias ${alias}; add one to deepswe/pair.aliases.json`);
    return route;
};

export interface OracleFacts {
    readonly reward: 0 | 1;
    readonly f2pPassed: number;
    readonly f2pTotal: number;
    readonly p2pPassed: number;
    readonly p2pTotal: number;
    readonly partial: number;
}

// The same fact shape for both sides. `state` says whether the side ran to a graded result;
// every other field is null when the harness did not supply it.
export interface SideFacts {
    readonly harness: "plurnk" | "mini-swe-agent";
    readonly state: "complete" | "failed" | "skipped" | "absent";
    readonly model: string | null;        // what the harness reports having called
    readonly oracle: OracleFacts | null;  // the submission grade
    readonly steps: number | null;        // plurnk model turns / mini agent steps
    readonly requests: number | null;     // provider requests / api calls
    readonly tokens: { readonly input: number; readonly cached: number | null; readonly output: number } | null;
    readonly costUsd: string | null;      // the candidate model's own cost; plurnk's requiem is excluded
    readonly agentSeconds: number | null; // the agent's own window
    readonly totalSeconds: number | null; // the harness's whole run
    readonly exit: string | null;         // how the agent's loop ended, in the harness's words
    readonly note: string | null;
    readonly evidence: string | null;     // result.json, relative to the pair directory
}

export interface PairRecord {
    readonly schemaVersion: 1;
    readonly task: string;
    readonly alias: string;
    readonly route: PairRoute;
    readonly budgetSeconds: number | null;         // the task's own agent budget (task.toml)
    readonly candidateTimeoutSeconds: number | null; // the benchlet's configured candidate timeout
    readonly startedAt: string;
    readonly plurnk: { readonly skipped: boolean; readonly command: readonly string[] | null };
    readonly mini: { readonly skipped: boolean; readonly command: readonly string[] | null };
}

const side = (harness: SideFacts["harness"], state: SideFacts["state"], note: string | null, evidence: string | null = null): SideFacts => ({
    harness, state, model: null, oracle: null, steps: null, requests: null, tokens: null, costUsd: null,
    agentSeconds: null, totalSeconds: null, exit: null, note, evidence,
});

const binaryReward = (value: unknown, subject: string): 0 | 1 => {
    if (value !== 0 && value !== 1) throw new TypeError(`${subject}: reward must be 0 or 1, got ${JSON.stringify(value)}`);
    return value;
};

const count = (value: unknown, subject: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${subject} must be a finite number`);
    return value;
};

const seconds = (startedAt: unknown, finishedAt: unknown): number | null => {
    if (typeof startedAt !== "string" || typeof finishedAt !== "string") return null;
    const ms = Date.parse(finishedAt) - Date.parse(startedAt);
    return Number.isFinite(ms) ? ms / 1_000 : null;
};

const onlyDirectory = (root: string, accept: (name: string) => boolean, what: string): string | null => {
    const names = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && accept(entry.name)).map((entry) => entry.name);
    if (names.length > 1) throw new Error(`${root}: a pair holds one ${what}, found ${names.length}: ${names.join(", ")}`);
    return names[0] === undefined ? null : resolve(root, names[0]);
};

interface PlurnkResult {
    harnessStatus: string;
    infrastructure?: { stage: string; message: string };
    candidate?: { outcome?: string; status: number | null; signal: string | null; timedOut: boolean; error: string | null; durationMs?: number };
    summary?: {
        modelTurns: number;
        providerRequests: number;
        models: string[];
        usage: { inputTokens: number; outputTokens: number; inputTokenDetails?: { cacheReadTokens?: number } } | null;
        costUsd: string | null;
        loopOutcomes: Array<{ loop: number; status: number; terminalMessage: string | null; terminatedBy: string | null }>;
    };
    oracle?: {
        submission: { applyFailed: boolean; reward: unknown; p2pPassed: number; p2pTotal: number; f2pPassed: number; f2pTotal: number; partial: number };
        submissionEvidence?: { emptyPatch?: boolean };
    };
    durationMs: number | null;
}

// The plurnk side: the single benchlet run directory under <pair>/plurnk, read from its result.json.
export const readPlurnkSide = (pairDir: string): SideFacts => {
    const root = resolve(pairDir, "plurnk");
    if (!existsSync(root)) return side("plurnk", "absent", "no plurnk directory in the pair");
    const runDir = onlyDirectory(root, (name) => /^run\d+-/u.test(name), "benchlet run");
    if (runDir === null) return side("plurnk", "absent", "the benchlet allocated no run directory");
    const resultPath = resolve(runDir, "result.json");
    const evidence = relative(pairDir, resultPath);
    if (!existsSync(resultPath)) return side("plurnk", "failed", "the benchlet wrote no result.json", evidence);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as PlurnkResult;
    if (result.harnessStatus === "infrastructure_error") {
        return side("plurnk", "failed", `${result.infrastructure?.stage ?? "unknown stage"}: ${result.infrastructure?.message ?? "no message"}`, evidence);
    }
    const { summary, oracle, candidate } = result;
    assert.ok(summary !== undefined && oracle !== undefined && candidate !== undefined, `${resultPath}: a ${result.harnessStatus} benchlet result carries summary, oracle and candidate`);
    const submission = oracle.submission;
    const rootLoop = summary.loopOutcomes.find(({ loop }) => loop === 1) ?? summary.loopOutcomes[0];
    const notes = [
        candidate.timedOut ? "candidate timed out" : null,
        candidate.error,
        // {§benchlet-candidate-exit} — a run that changed nothing is not a near-miss (#41).
        oracle.submissionEvidence?.emptyPatch === true ? "the candidate produced no patch" : null,
        submission.applyFailed ? "submission patch did not apply" : null,
        result.harnessStatus === "complete" ? null : `harness status ${result.harnessStatus}`,
    ].filter((note): note is string => note !== null);
    return {
        harness: "plurnk",
        state: "complete",
        model: summary.models.length === 0 ? null : summary.models.join(", "),
        oracle: {
            reward: binaryReward(submission.reward, resultPath),
            f2pPassed: submission.f2pPassed, f2pTotal: submission.f2pTotal,
            p2pPassed: submission.p2pPassed, p2pTotal: submission.p2pTotal,
            partial: submission.partial,
        },
        steps: summary.modelTurns,
        requests: summary.providerRequests,
        tokens: summary.usage === null ? null : {
            input: summary.usage.inputTokens,
            cached: summary.usage.inputTokenDetails?.cacheReadTokens ?? null,
            output: summary.usage.outputTokens,
        },
        costUsd: summary.costUsd,
        agentSeconds: candidate.durationMs === undefined ? null : candidate.durationMs / 1_000,
        totalSeconds: result.durationMs === null ? null : result.durationMs / 1_000,
        exit: rootLoop === undefined ? null : `${rootLoop.status}${rootLoop.terminatedBy === null ? "" : ` (${rootLoop.terminatedBy})`}${rootLoop.terminalMessage === null ? "" : ` ${rootLoop.terminalMessage}`}`,
        note: notes.length === 0 ? null : notes.join("; "),
        evidence,
    };
};

interface MiniResult {
    exception_info: unknown;
    agent_info?: { model_info?: { name?: string; provider?: string } };
    agent_result?: { n_input_tokens?: number | null; n_cache_tokens?: number | null; n_output_tokens?: number | null; cost_usd?: number | null; n_agent_steps?: number | null };
    verifier_result?: { rewards?: Record<string, unknown> } | null;
    agent_execution?: { started_at?: string; finished_at?: string };
    started_at?: string;
    finished_at?: string;
}

// {§pair-mini-digest} — the trajectory read into steps.md / steps.json under <trial>/digest, the
// same place the plurnk run keeps its digest, so both sides are read by one reader.
export const digestMiniTrial = (trialDir: string): MiniTrajectory => {
    const trajectory = MiniTrajectoryReader.read(resolve(trialDir, "agent", "mini-swe-agent.trajectory.json"));
    const digestDir = resolve(trialDir, "digest");
    mkdirSync(digestDir, { recursive: true });
    writeFileSync(resolve(digestDir, "steps.json"), `${JSON.stringify(trajectory, null, 2)}\n`);
    writeFileSync(resolve(digestDir, "steps.md"), MiniTrajectoryReader.render(trajectory));
    return trajectory;
};

// The mini side: Pier's job directory is <pair>/mini; its single trial holds result.json.
export const readMiniSide = (pairDir: string): SideFacts => {
    const root = resolve(pairDir, "mini");
    if (!existsSync(root)) return side("mini-swe-agent", "absent", "no mini directory in the pair");
    const trialDir = onlyDirectory(root, (name) => existsSync(resolve(root, name, "result.json")), "trial");
    if (trialDir === null) return side("mini-swe-agent", "failed", "pier finished no trial (no trial result.json)");
    const resultPath = resolve(trialDir, "result.json");
    const evidence = relative(pairDir, resultPath);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as MiniResult;
    const trajectoryPath = resolve(trialDir, "agent", "mini-swe-agent.trajectory.json");
    const trajectory = existsSync(trajectoryPath) ? digestMiniTrial(trialDir) : null;
    const exception = result.exception_info === null || result.exception_info === undefined ? null : JSON.stringify(result.exception_info).slice(0, 300);
    const rewards = result.verifier_result?.rewards;
    const agent = result.agent_result;
    if (rewards === undefined || rewards === null) {
        return { ...side("mini-swe-agent", "failed", exception ?? "the trial carries no verifier rewards", evidence), model: result.agent_info?.model_info?.name ?? null };
    }
    return {
        harness: "mini-swe-agent",
        state: "complete",
        model: result.agent_info?.model_info?.name ?? trajectory?.model ?? null,
        oracle: {
            reward: binaryReward(rewards.reward, resultPath),
            f2pPassed: count(rewards.f2p_passed, `${resultPath} f2p_passed`), f2pTotal: count(rewards.f2p_total, `${resultPath} f2p_total`),
            p2pPassed: count(rewards.p2p_passed, `${resultPath} p2p_passed`), p2pTotal: count(rewards.p2p_total, `${resultPath} p2p_total`),
            partial: count(rewards.partial, `${resultPath} partial`),
        },
        steps: agent?.n_agent_steps ?? null,
        requests: trajectory?.totals.responses ?? null,
        tokens: typeof agent?.n_input_tokens === "number" && typeof agent.n_output_tokens === "number"
            ? { input: agent.n_input_tokens, cached: agent.n_cache_tokens ?? null, output: agent.n_output_tokens }
            : null,
        costUsd: typeof agent?.cost_usd === "number" ? String(agent.cost_usd) : null,
        agentSeconds: seconds(result.agent_execution?.started_at, result.agent_execution?.finished_at),
        totalSeconds: seconds(result.started_at, result.finished_at),
        exit: trajectory?.exit.status ?? null,
        note: exception,
        evidence,
    };
};

const absent = "absent";
const num = (value: number | null, digits = 0): string => value === null ? absent : value.toFixed(digits);
const clock = (value: number | null): string => {
    if (value === null) return absent;
    const whole = Math.round(value);
    return `${Math.floor(whole / 60)} m ${String(whole % 60).padStart(2, "0")} s`;
};
const ratio = (passed: number, total: number): string => `${passed}/${total}`;
const cell = (value: string | null): string => (value ?? absent).replaceAll("|", "\\|").replaceAll("\n", " ");

// PAIR.md: the two fact columns and where each came from. Facts only.
export const renderSheet = (pair: PairRecord, plurnk: SideFacts, mini: SideFacts): string => {
    const rows: Array<[string, string, string]> = [
        ["state", plurnk.state, mini.state],
        ["route", `${pair.alias}`, `${pair.route.model} (${pair.route.reasoningEffort})`],
        ["model reported", cell(plurnk.model), cell(mini.model)],
        ["reward", plurnk.oracle === null ? absent : String(plurnk.oracle.reward), mini.oracle === null ? absent : String(mini.oracle.reward)],
        ["f2p passed", plurnk.oracle === null ? absent : ratio(plurnk.oracle.f2pPassed, plurnk.oracle.f2pTotal), mini.oracle === null ? absent : ratio(mini.oracle.f2pPassed, mini.oracle.f2pTotal)],
        ["p2p passed", plurnk.oracle === null ? absent : ratio(plurnk.oracle.p2pPassed, plurnk.oracle.p2pTotal), mini.oracle === null ? absent : ratio(mini.oracle.p2pPassed, mini.oracle.p2pTotal)],
        ["partial", plurnk.oracle === null ? absent : plurnk.oracle.partial.toFixed(3), mini.oracle === null ? absent : mini.oracle.partial.toFixed(3)],
        ["steps", plurnk.steps === null ? absent : `${plurnk.steps} turns`, mini.steps === null ? absent : `${mini.steps} steps`],
        ["provider requests", num(plurnk.requests), num(mini.requests)],
        ["input tokens", plurnk.tokens === null ? absent : String(plurnk.tokens.input), mini.tokens === null ? absent : String(mini.tokens.input)],
        ["cached input tokens", plurnk.tokens === null ? absent : num(plurnk.tokens.cached), mini.tokens === null ? absent : num(mini.tokens.cached)],
        ["output tokens", plurnk.tokens === null ? absent : String(plurnk.tokens.output), mini.tokens === null ? absent : String(mini.tokens.output)],
        ["cost USD", cell(plurnk.costUsd), cell(mini.costUsd)],
        ["agent wall time", clock(plurnk.agentSeconds), clock(mini.agentSeconds)],
        ["harness wall time", clock(plurnk.totalSeconds), clock(mini.totalSeconds)],
        ["exit", cell(plurnk.exit), cell(mini.exit)],
        ["note", cell(plurnk.note), cell(mini.note)],
        ["evidence", cell(plurnk.evidence), cell(mini.evidence)],
    ];
    return [
        `# ${pair.task} · ${pair.alias}`,
        "",
        `Started ${pair.startedAt}. Task agent budget ${pair.budgetSeconds === null ? absent : `${pair.budgetSeconds} s`}; `
        + `plurnk candidate timeout ${pair.candidateTimeoutSeconds === null ? absent : `${pair.candidateTimeoutSeconds} s`}; mini runs on Pier's task timeout.`,
        "Cost is each side's candidate model only (plurnk's requiem is excluded). Cached tokens are the provider's cache reads.",
        "",
        "| | plurnk | mini-swe-agent |",
        "|---|---|---|",
        ...rows.map(([label, left, right]) => `| ${label} | ${left} | ${right} |`),
        "",
        "Read the plurnk side in its run directory's `digest/` and the mini side in `mini/<trial>/digest/steps.md` ({§pair-mini-digest}).",
        "",
    ].join("\n");
};

export const writeSheet = (pairDir: string): { plurnk: SideFacts; mini: SideFacts } => {
    const pair = JSON.parse(readFileSync(resolve(pairDir, "pair.json"), "utf8")) as PairRecord;
    const plurnk = pair.plurnk.skipped ? side("plurnk", "skipped", "skipped by --skip-plurnk") : readPlurnkSide(pairDir);
    const mini = pair.mini.skipped ? side("mini-swe-agent", "skipped", "skipped by --skip-mini") : readMiniSide(pairDir);
    writeFileSync(resolve(pairDir, "PAIR.md"), renderSheet(pair, plurnk, mini));
    writeFileSync(resolve(pairDir, "facts.json"), `${JSON.stringify({ plurnk, mini }, null, 2)}\n`);
    return { plurnk, mini };
};

// task.toml's `[agent] timeout_sec` — the budget Pier enforces on the mini side; the benchlet's
// candidate timeout is the operator's parity setting for the plurnk side (.env.defaults).
export const agentBudgetSeconds = (toml: string): number | null => {
    const lines = toml.split("\n");
    const start = lines.findIndex((line) => line.trim() === "[agent]");
    if (start < 0) return null;
    for (const line of lines.slice(start + 1)) {
        if (/^\s*\[/u.test(line)) break;
        const match = /^\s*timeout_sec\s*=\s*([0-9.]+)\s*$/u.exec(line);
        if (match !== null) return Number(match[1]);
    }
    return null;
};

const stamp = (now: Date): string => now.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");

const run = (command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): number => {
    const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
    if (result.error !== undefined) throw result.error;
    return result.status ?? 1;
};

const main = (): void => {
    loadBenchmarkEnvironment(process.env.PLURNK_BENCHLET_OPERATOR_ENV, resolve(BENCH_ROOT, ".env.defaults"));
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            task: { type: "string" },
            alias: { type: "string" },
            preflight: { type: "boolean", default: false },
            "skip-plurnk": { type: "boolean", default: false },
            "skip-mini": { type: "boolean", default: false },
            sheet: { type: "string" },
        },
        allowPositionals: false,
        strict: true,
    });
    if (values.sheet !== undefined) {
        const { plurnk, mini } = writeSheet(resolve(process.cwd(), values.sheet));
        console.log(`pair: sheet rewritten (plurnk ${plurnk.state}, mini ${mini.state})`);
        return;
    }
    const task = values.task?.trim();
    if (task === undefined || task === "") throw new Error("pair requires --task <task>");
    const alias = values.alias?.trim() || selectedModel();
    const route = routeFor(readRoutes(ROUTES_PATH), alias);
    const manifestPath = resolve(HERE, "benchlet.manifests", `${task}.json`);
    if (!existsSync(manifestPath)) throw new Error(`pair has no pinned benchlet manifest for task: ${task}`);
    const taskCache = resolve(BENCH_ROOT, process.env.PLURNK_BENCHLET_TASK_CACHE ?? ".cache/deep-swe/tasks");
    const taskToml = resolve(taskCache, task, "task.toml");
    if (!existsSync(taskToml)) throw new Error(`pair needs the DeepSWE task cache entry ${taskToml} for Pier`);
    const budget = agentBudgetSeconds(readFileSync(taskToml, "utf8"));
    const key = process.env[route.keyEnv];
    if (!values["skip-mini"] && (key === undefined || key.trim() === "")) throw new Error(`pair needs ${route.keyEnv} in the environment for the mini-swe-agent side`);
    if (!values["skip-mini"] && spawnSync("pier", ["--help"], { stdio: "ignore" }).error !== undefined) throw new Error("pair needs pier on PATH for the mini-swe-agent side");
    const candidateTimeout = Number(process.env.PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC);

    const plurnkCommand = ["deepswe/benchlet.sh", "--task", task];
    // The key travels only through the spawned environment; the recorded command names its variable.
    const miniCommand = [
        "pier", "run", "-p", relative(BENCH_ROOT, taskCache), "-a", "mini-swe-agent", "-m", route.model,
        "--ak", `reasoning_effort=${route.reasoningEffort}`,
        "--ae", `OPENAI_BASE_URL=${route.baseUrl}`, "--ae", `OPENAI_API_KEY=$${route.keyEnv}`,
        "-i", task, "-k", "1", "-n", "1", "--job-name", "mini", "--env", "docker",
    ];
    if (values.preflight) {
        console.log(`pair: ${task} on ${alias} → mini ${route.model} (${route.reasoningEffort}) via ${route.keyEnv}; budget ${budget ?? absent} s`);
        const status = run("deepswe/benchlet.sh", ["--task", task, "--preflight"], { ...process.env, PLURNK_MODEL: alias }, BENCH_ROOT);
        if (status !== 0) throw new Error(`benchlet preflight exited ${status}`);
        console.log(`pair: preflight complete; mini command: ${miniCommand.join(" ")}`);
        return;
    }

    const startedAt = new Date();
    const pairsRoot = jobsRoot("pairs");
    mkdirSync(pairsRoot, { recursive: true });
    const pairDir = resolve(pairsRoot, `${task}-${alias}-${stamp(startedAt)}`);
    mkdirSync(pairDir);
    const pair: PairRecord = {
        schemaVersion: 1,
        task,
        alias,
        route,
        budgetSeconds: budget,
        candidateTimeoutSeconds: Number.isFinite(candidateTimeout) ? candidateTimeout : null,
        startedAt: startedAt.toISOString(),
        plurnk: { skipped: values["skip-plurnk"], command: values["skip-plurnk"] ? null : plurnkCommand },
        mini: { skipped: values["skip-mini"], command: values["skip-mini"] ? null : miniCommand },
    };
    writeFileSync(resolve(pairDir, "pair.json"), `${JSON.stringify(pair, null, 2)}\n`);
    console.log(`pair: ${pairDir}`);

    // One side at a time: the two candidates never share the host's clock or its docker daemon.
    const exits: Record<string, number> = {};
    if (!pair.plurnk.skipped) {
        const runsRoot = resolve(pairDir, "plurnk");
        mkdirSync(runsRoot);
        exits.plurnk = run(plurnkCommand[0]!, plurnkCommand.slice(1), { ...process.env, PLURNK_MODEL: alias, PLURNK_BENCHLET_RUNS_ROOT: runsRoot }, BENCH_ROOT);
        console.log(`pair: plurnk side exited ${exits.plurnk}`);
    }
    if (!pair.mini.skipped) {
        const args = miniCommand.slice(1).map((arg) => arg === `OPENAI_API_KEY=$${route.keyEnv}` ? `OPENAI_API_KEY=${key}` : arg);
        exits.mini = run("pier", [...args, "-o", pairDir], process.env, BENCH_ROOT);
        console.log(`pair: mini side exited ${exits.mini}`);
    }
    const { plurnk, mini } = writeSheet(pairDir);
    console.log(`pair: ${resolve(pairDir, "PAIR.md")} (plurnk ${plurnk.state}, mini ${mini.state})`);
    const failed = Object.entries(exits).filter(([, status]) => status !== 0).map(([name]) => name);
    if (failed.length > 0) throw new Error(`pair: ${failed.join(" and ")} exited non-zero; the sheet records what each side left behind`);
};

if (import.meta.main) main();
