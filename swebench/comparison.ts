// {§swebench-comparison} — the study's own method over one campaign: attempts averaged within
// each task, then across tasks; intervals from bootstrap resamples of tasks under a declared
// seed; each K3 baseline the corpus source carries compared per task, paired, with Holm
// correction. `swebench/report.ts` renders it as the sheet's statistics section.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapMean, holm, mean, median, seededUniform, signFlipP, type Interval } from "../src/statistics.ts";
import type { TrialRow } from "./report.ts";

export const RESAMPLES = 10_000;
export const SEED = "harnesstax";
const BASELINE_ATTEMPTS = 3;
const LABELS: Readonly<Record<string, string>> = Object.freeze({ cc: "K3 · Claude Code", codex: "K3 · Codex", pi: "K3 · Pi" });

export type Baselines = ReadonlyMap<string, Readonly<Record<string, number>>>;

export interface TaskStat {
    readonly instance: string;
    readonly attempts: number;
    readonly graded: number;
    readonly resolved: number;
    readonly resolveRate: number | null;
    readonly meanCostUsd: number | null;
    readonly baseline: Readonly<Record<string, number>>;   // the study's successes of three per harness key
}

export interface Paired {
    readonly key: string;
    readonly label: string;
    readonly tasks: number;
    readonly differencePp: number;
    readonly lowPp: number;
    readonly highPp: number;
    readonly p: number;
    readonly pHolm: number;
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
}

export interface Comparison {
    readonly resamples: number;
    readonly seed: string;
    readonly tasks: readonly TaskStat[];
    readonly rollouts: number;
    readonly resolvedRollouts: number;
    readonly resolveRate: Interval | null;
    readonly costPerRollout: Interval | null;
    readonly costPerSolve: number | null;
    readonly medianGrossTokens: number | null;
    readonly medianCalls: number | null;
    readonly medianTurns: number | null;
    readonly baselineKeys: readonly string[];
    readonly paired: readonly Paired[];
}

export const perTask = (rows: readonly TrialRow[]): TaskStat[] => {
    const byInstance = new Map<string, TrialRow[]>();
    for (const row of rows) byInstance.set(row.instance, [...(byInstance.get(row.instance) ?? []), row]);
    return [...byInstance].toSorted(([left], [right]) => left.localeCompare(right)).map(([instance, attempts]) => {
        const graded = attempts.filter((row) => row.reward !== null);
        const resolved = graded.filter((row) => row.reward === 1);
        const costs = attempts.map((row) => row.costUsd).filter((value): value is number => value !== null);
        return {
            instance,
            attempts: attempts.length,
            graded: graded.length,
            resolved: resolved.length,
            resolveRate: graded.length === 0 ? null : resolved.length / graded.length,
            meanCostUsd: costs.length === 0 ? null : mean(costs),
            baseline: {},
        };
    });
};

export const compare = (tasks: readonly TaskStat[], baselines: Baselines, key: string, resamples: number, seed: string): Paired | null => {
    const diffs: number[] = [];
    let wins = 0; let losses = 0; let ties = 0;
    for (const task of tasks) {
        const baseline = baselines.get(task.instance)?.[key];
        if (task.resolveRate === null || baseline === undefined) continue;
        const diff = task.resolveRate - baseline / BASELINE_ATTEMPTS;
        diffs.push(diff);
        if (Math.abs(diff) < 1e-12) ties += 1;
        else if (diff > 0) wins += 1;
        else losses += 1;
    }
    if (diffs.length === 0) return null;
    const interval = bootstrapMean(diffs, resamples, seededUniform(`${seed}|${key}|ci`));
    return {
        key,
        label: LABELS[key] ?? key,
        tasks: diffs.length,
        differencePp: interval.mean * 100,
        lowPp: interval.low * 100,
        highPp: interval.high * 100,
        p: signFlipP(diffs, resamples, seededUniform(`${seed}|${key}|p`)),
        pHolm: 0,
        wins,
        losses,
        ties,
    };
};

export const compareBaselines = (rows: readonly TrialRow[], baselines: Baselines, options: { resamples?: number; seed?: string } = {}): Comparison => {
    const resamples = options.resamples ?? RESAMPLES;
    const seed = options.seed ?? SEED;
    const tasks = perTask(rows).map((task) => ({ ...task, baseline: baselines.get(task.instance) ?? {} }));
    const rates = tasks.map((task) => task.resolveRate).filter((value): value is number => value !== null);
    const costs = tasks.map((task) => task.meanCostUsd).filter((value): value is number => value !== null);
    const graded = rows.filter((row) => row.reward !== null);
    const resolvedRollouts = graded.filter((row) => row.reward === 1).length;
    const spent = rows.map((row) => row.costUsd).filter((value): value is number => value !== null);
    const baselineKeys = [...new Set([...baselines.values()].flatMap((entry) => Object.keys(entry)))];
    const paired = baselineKeys.map((key) => compare(tasks, baselines, key, resamples, seed)).filter((entry): entry is Paired => entry !== null);
    const corrected = holm(paired.map((entry) => entry.p));
    return {
        resamples,
        seed,
        tasks,
        rollouts: graded.length,
        resolvedRollouts,
        resolveRate: rates.length === 0 ? null : bootstrapMean(rates, resamples, seededUniform(`${seed}|resolve`)),
        costPerRollout: costs.length === 0 ? null : bootstrapMean(costs, resamples, seededUniform(`${seed}|cost`)),
        costPerSolve: resolvedRollouts === 0 || spent.length === 0 ? null : spent.reduce((total, value) => total + value, 0) / resolvedRollouts,
        medianGrossTokens: median(rows.map((row) => row.tokens).filter((tokens): tokens is NonNullable<TrialRow["tokens"]> => tokens !== null).map((tokens) => tokens.input + tokens.output)),
        medianCalls: median(rows.map((row) => row.requests).filter((value): value is number => value !== null)),
        medianTurns: median(rows.map((row) => row.turns)),
        baselineKeys,
        paired: paired.map((entry, index) => ({ ...entry, pHolm: corrected[index]! })),
    };
};

// The corpus source carries the study's per-task baselines beside the ids ({§swebench-corpus}).
export const baselinesFor = (corpus: string): Baselines | null => {
    const file = join(dirname(fileURLToPath(import.meta.url)), "corpora", `${corpus}.source.json`);
    if (!existsSync(file)) return null;
    const source = JSON.parse(readFileSync(file, "utf8")) as { tasks?: Array<{ instance_id: string; k3?: Record<string, number> }> };
    const entries = (source.tasks ?? []).filter((task) => task.k3 !== undefined).map((task) => [task.instance_id, task.k3!] as const);
    return entries.length === 0 ? null : new Map(entries);
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const usd = (value: number): string => `$${value.toFixed(3)}`;
const pp = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(1)} pp`;
const count = (value: number | null): string => value === null ? "—" : Math.round(value).toLocaleString("en-US");

export const renderComparison = (comparison: Comparison, harness: string): string[] => {
    const resolved = comparison.resolveRate === null ? "—" : `${pct(comparison.resolveRate.mean)} (${comparison.resolvedRollouts}/${comparison.rollouts})`;
    const resolvedCi = comparison.resolveRate === null ? "—" : `${pct(comparison.resolveRate.low)}–${pct(comparison.resolveRate.high)}`;
    const cost = comparison.costPerRollout === null ? "—" : usd(comparison.costPerRollout.mean);
    const costCi = comparison.costPerRollout === null ? "—" : `${usd(comparison.costPerRollout.low)}–${usd(comparison.costPerRollout.high)}`;
    const keys = comparison.baselineKeys;
    return [
        "## Statistics",
        "",
        `Attempts averaged within each task, then across ${comparison.tasks.length} tasks; 95% intervals from ${comparison.resamples.toLocaleString("en-US")} bootstrap resamples of tasks (seed \`${comparison.seed}\`); each baseline compared per task, paired, by a sign-flip permutation test with Holm correction. Cost per solve is total spend over resolved rollouts; tokens, calls and turns are medians per rollout. Dollars are approximate: compare tokens and calls first.`,
        "",
        "| Harness | Resolved | Resolved 95% CI | Cost/rollout | Cost 95% CI | Cost/solve | Median tokens | Median model calls | Median loop turns |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
        `| ${harness} | ${resolved} | ${resolvedCi} | ${cost} | ${costCi} | ${comparison.costPerSolve === null ? "—" : usd(comparison.costPerSolve)} | ${count(comparison.medianGrossTokens)} | ${count(comparison.medianCalls)} | ${count(comparison.medianTurns)} |`,
        "",
        ...(comparison.paired.length === 0 ? [] : [
            "| Comparison | Resolved difference (95% CI) | p | p (Holm) | Task wins / losses / ties |",
            "|---|---:|---:|---:|:---:|",
            ...comparison.paired.map((entry) => `| ${harness} vs ${entry.label} | ${pp(entry.differencePp)} (${entry.lowPp.toFixed(1)} to ${entry.highPp.toFixed(1)}) | ${entry.p.toFixed(4)} | ${entry.pHolm.toFixed(4)} | ${entry.wins} / ${entry.losses} / ${entry.ties} |`),
            "",
        ]),
        `| Instance | ${harness} | ${keys.map((key) => LABELS[key] ?? key).join(" | ")} |`,
        `|---|:---:|${keys.map(() => ":---:").join("|")}|`,
        ...comparison.tasks.map((task) => `| \`${task.instance}\` | ${task.graded === 0 ? "—" : `${task.resolved}/${task.graded}`} | ${keys.map((key) => task.baseline[key] === undefined ? "—" : `${task.baseline[key]}/${BASELINE_ATTEMPTS}`).join(" | ")} |`),
        "",
    ];
};
