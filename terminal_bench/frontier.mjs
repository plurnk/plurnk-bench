#!/usr/bin/env node
// FrontierHarness Eval v1 parity lane (#22): the deterministic half of terminal_bench/frontier.sh.
//   plan [--manifest <file>]   one JSON line per task: {source, task, dir, budget, image}
//   summary <run-dir>          pass/fail per task from Harbor's verifier/reward.txt, then totals
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DEFAULT_MANIFEST = join(HERE, "frontier.manifest.json");
// Daemon boot + snapshot headroom inside the task's [agent] budget — deepswe/smoke.sh's number.
export const HEADROOM_SEC = 120;

// [section] key = value, the two task.toml facts the lane needs; no TOML dependency.
export const tomlValue = (text, section, key) => {
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

export const readManifest = (path = DEFAULT_MANIFEST) => {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const sources = [["terminal_bench", manifest.terminal_bench], ["deep_swe", manifest.deep_swe]];
    const tasks = sources.flatMap(([source, block]) => block.tasks.map((task) => ({ source, task, dir: resolve(ROOT, block.cache, task) })));
    const names = tasks.map(({ task }) => task);
    if (new Set(names).size !== names.length) throw new Error("frontier manifest names a task twice");
    return { manifest, tasks };
};

export const plan = (path) => readManifest(path).tasks.map((entry) => {
    const toml = join(entry.dir, "task.toml");
    if (!existsSync(toml)) throw new Error(`${entry.source}/${entry.task}: no task at ${entry.dir} (download the corpus first; see terminal_bench/frontier.sh)`);
    const text = readFileSync(toml, "utf8");
    const budget = Number(tomlValue(text, "agent", "timeout_sec"));
    if (!Number.isFinite(budget) || budget <= HEADROOM_SEC) throw new Error(`${entry.task}: [agent] timeout_sec unreadable or below headroom in ${toml}`);
    return { ...entry, budget: Math.trunc(budget), client_timeout_sec: Math.trunc(budget) - HEADROOM_SEC, image: tomlValue(text, "environment", "docker_image") };
});

const finiteNonNegative = (value, subject) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${subject} must be a finite non-negative number`);
    }
    return value;
};

const trialDurationMs = (trialDir) => {
    if (trialDir === null) return null;
    const resultPath = join(trialDir, "result.json");
    if (!existsSync(resultPath) || statSync(resultPath).size === 0) return null;
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    if (result.finished_at === null || result.finished_at === undefined) return null;
    if (typeof result.started_at !== "string" || typeof result.finished_at !== "string") {
        throw new TypeError(`${resultPath}: started_at and finished_at must be ISO timestamps`);
    }
    const started = Date.parse(result.started_at);
    const finished = Date.parse(result.finished_at);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
        throw new TypeError(`${resultPath}: trial timestamps do not describe a non-negative duration`);
    }
    return finished - started;
};

const taskTelemetry = (trialDir) => {
    const durationMs = trialDurationMs(trialDir);
    if (trialDir === null) return { costUsd: null, cacheHitRate: null, durationMs };
    const documentPath = join(trialDir, "agent", "plurnk.json");
    if (!existsSync(documentPath)) return { costUsd: null, cacheHitRate: null, durationMs };
    if (statSync(documentPath).size === 0) return { costUsd: null, cacheHitRate: null, durationMs };
    const document = JSON.parse(readFileSync(documentPath, "utf8"));
    const accounting = document.usage?.accounting;
    const cost = accounting?.costUsd;
    if (cost !== null && cost !== undefined && (typeof cost !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(cost))) {
        throw new TypeError(`${documentPath}: usage.accounting.costUsd must be a canonical non-negative decimal string or null`);
    }
    const inputTokens = accounting?.usage?.inputTokens;
    const cacheReadTokens = accounting?.usage?.inputTokenDetails?.cacheReadTokens;
    const input = inputTokens === undefined ? null : finiteNonNegative(inputTokens, `${documentPath}: input tokens`);
    const cached = cacheReadTokens === undefined ? null : finiteNonNegative(cacheReadTokens, `${documentPath}: cache-read tokens`);
    if (input !== null && cached !== null && cached > input) {
        throw new TypeError(`${documentPath}: cache-read tokens cannot exceed input tokens`);
    }
    const cacheHitRate = input === null || cached === null || input === 0 ? null : cached / input;
    return {
        costUsd: cost === null || cost === undefined
            ? null
            : finiteNonNegative(Number(cost), `${documentPath}: usage.accounting.costUsd`),
        cacheHitRate,
        durationMs,
    };
};

export const median = (values) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const reported = (rows, read) => rows.map(read).filter((value) => value !== null);

const metric = (values, eligible) => ({ value: median(values), reported: values.length, eligible });

// Harbor writes one job dir per launch: <run>/<task>/<task>__<id>/verifier/reward.txt ("1.0" | "0" | "0.0").
export const summary = (runDir, path) => {
    const rows = readManifest(path).tasks.map(({ source, task }) => {
        const jobDir = join(runDir, task);
        const trials = existsSync(jobDir) ? readdirSync(jobDir).filter((name) => name.startsWith(`${task}__`) && statSync(join(jobDir, name)).isDirectory()) : [];
        const trialDir = trials.map((trial) => join(jobDir, trial)).find((dir) => existsSync(join(dir, "verifier", "reward.txt")))
            ?? (trials[0] === undefined ? null : join(jobDir, trials[0]));
        const rewardFile = trialDir === null ? null : join(trialDir, "verifier", "reward.txt");
        const reward = rewardFile === null || !existsSync(rewardFile) ? null : Number(readFileSync(rewardFile, "utf8").trim());
        return {
            source,
            task,
            reward,
            verdict: reward === null ? "missing" : reward >= 1 ? "pass" : "fail",
            ...taskTelemetry(trialDir),
        };
    });
    const count = (verdict, source) => rows.filter((row) => row.verdict === verdict && (source === undefined || row.source === source)).length;
    const passed = count("pass");
    const failed = count("fail");
    const scored = rows.filter(({ verdict }) => verdict !== "missing");
    const successful = rows.filter(({ verdict }) => verdict === "pass");
    const successfulCosts = reported(successful, ({ costUsd }) => costUsd);
    const taskCosts = reported(scored, ({ costUsd }) => costUsd);
    const successfulCacheRates = reported(successful, ({ cacheHitRate }) => cacheHitRate);
    const successfulDurations = reported(successful, ({ durationMs }) => durationMs);
    return {
        rows,
        passed,
        failed,
        missing: count("missing"),
        terminal_bench: { passed: count("pass", "terminal_bench"), total: rows.filter((row) => row.source === "terminal_bench").length },
        deep_swe: { passed: count("pass", "deep_swe"), total: rows.filter((row) => row.source === "deep_swe").length },
        metrics: {
            passRate: scored.length === 0 ? null : passed / scored.length,
            medianCostPerSuccessfulTaskUsd: metric(successfulCosts, successful.length),
            medianCostPerTaskUsd: metric(taskCosts, scored.length),
            medianCacheHitRatePerSuccessfulTask: metric(successfulCacheRates, successful.length),
            medianTimePerSuccessfulTaskMs: metric(successfulDurations, successful.length),
        },
    };
};

const coverage = ({ reported, eligible }) => reported === eligible ? "" : ` (${reported}/${eligible} reported)`;
const dollars = ({ value }) => value === null ? "n/a" : `$${value.toFixed(2)}`;
const percent = (value) => value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
const duration = ({ value }) => {
    if (value === null) return "n/a";
    const seconds = Math.round(value / 1_000);
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

const main = () => {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { manifest: { type: "string" } } });
    const [command, arg] = positionals;
    if (command === "plan") {
        for (const row of plan(values.manifest)) process.stdout.write(`${JSON.stringify(row)}\n`);
        return;
    }
    if (command === "summary") {
        if (!arg) throw new Error("summary needs a run directory");
        const result = summary(resolve(arg), values.manifest);
        for (const row of result.rows) process.stdout.write(`${row.verdict.padEnd(7)} ${row.source.padEnd(14)} ${row.task}\n`);
        process.stdout.write(`passed ${result.passed}/${result.rows.length} (terminal_bench ${result.terminal_bench.passed}/${result.terminal_bench.total}, deep_swe ${result.deep_swe.passed}/${result.deep_swe.total}); failed ${result.failed}; missing ${result.missing}\n`);
        process.stdout.write(`Pass Rate: ${percent(result.metrics.passRate)} (${result.passed}/${result.passed + result.failed} scored)\n`);
        process.stdout.write(`Median Cost per Successful Task: ${dollars(result.metrics.medianCostPerSuccessfulTaskUsd)}${coverage(result.metrics.medianCostPerSuccessfulTaskUsd)}\n`);
        process.stdout.write(`Median Cost per Task: ${dollars(result.metrics.medianCostPerTaskUsd)}${coverage(result.metrics.medianCostPerTaskUsd)}\n`);
        process.stdout.write(`Median Cache Hit Rate per Successful Task: ${percent(result.metrics.medianCacheHitRatePerSuccessfulTask.value)}${coverage(result.metrics.medianCacheHitRatePerSuccessfulTask)}\n`);
        process.stdout.write(`Median Time per Successful Task: ${duration(result.metrics.medianTimePerSuccessfulTaskMs)}${coverage(result.metrics.medianTimePerSuccessfulTaskMs)}\n`);
        return;
    }
    throw new Error("usage: frontier.mjs plan [--manifest <file>] | summary <run-dir> [--manifest <file>]");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
