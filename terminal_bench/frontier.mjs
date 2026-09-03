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

// Harbor writes one job dir per launch: <run>/<task>/<task>__<id>/verifier/reward.txt ("1.0" | "0" | "0.0").
export const summary = (runDir, path) => {
    const rows = readManifest(path).tasks.map(({ source, task }) => {
        const jobDir = join(runDir, task);
        const trials = existsSync(jobDir) ? readdirSync(jobDir).filter((name) => name.startsWith(`${task}__`) && statSync(join(jobDir, name)).isDirectory()) : [];
        const rewardFile = trials.map((trial) => join(jobDir, trial, "verifier", "reward.txt")).find((file) => existsSync(file));
        const reward = rewardFile === undefined ? null : Number(readFileSync(rewardFile, "utf8").trim());
        return { source, task, reward, verdict: reward === null ? "missing" : reward >= 1 ? "pass" : "fail" };
    });
    const count = (verdict, source) => rows.filter((row) => row.verdict === verdict && (source === undefined || row.source === source)).length;
    return {
        rows,
        passed: count("pass"),
        failed: count("fail"),
        missing: count("missing"),
        terminal_bench: { passed: count("pass", "terminal_bench"), total: rows.filter((row) => row.source === "terminal_bench").length },
        deep_swe: { passed: count("pass", "deep_swe"), total: rows.filter((row) => row.source === "deep_swe").length },
    };
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
        return;
    }
    throw new Error("usage: frontier.mjs plan [--manifest <file>] | summary <run-dir> [--manifest <file>]");
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
