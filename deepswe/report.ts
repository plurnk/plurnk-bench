import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { addSettledUsd, summarizeDigestAccounting } from "../src/accounting.ts";
import type { AccountingSummary, DigestAccountingInput } from "../src/accounting.ts";
import { readTrialDir } from "../src/ingest.ts";
import { PUBLISHED_MARKER } from "../src/publish.ts";
import { median } from "../src/statistics.ts";
import { compareBaseline, type BaselineTrial } from "./comparison.ts";

type CostEvidence = { charged: number; estimated: number; unknown: number };
export interface TaskReport {
    task: string;
    reward: number | null;
    outcome: string;
    durationMs: number | null;
    evidence: string;
    accounting: AccountingSummary | null;
    costEvidence: CostEvidence | null;
}

const json = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const metric = (values: Array<number | null | undefined>) => {
    const known = values.filter((value): value is number => value !== null && value !== undefined);
    return { value: median(known), reported: known.length, eligible: values.length };
};

export const summarizeTasks = (rows: TaskReport[]) => {
    if (new Set(rows.map(({ task }) => task)).size !== rows.length) {
        throw new Error("duplicate task: select one campaign attempt per task");
    }
    const graded = rows.filter(({ reward }) => reward !== null);
    const successful = graded.filter(({ reward }) => reward === 1);
    const cost = ({ accounting }: TaskReport) => accounting?.costUsd === null || accounting?.costUsd === undefined
        ? null : Number(accounting.costUsd);
    const costs = rows.map(({ accounting }) => accounting?.costUsd ?? null);
    const costEvidence: CostEvidence = { charged: 0, estimated: 0, unknown: 0 };
    for (const row of rows) {
        for (const kind of ["charged", "estimated", "unknown"] as const) {
            costEvidence[kind] += row.costEvidence?.[kind] ?? 0;
        }
    }
    return {
        rows, passed: successful.length, graded: graded.length, ungraded: rows.length - graded.length,
        accountingCoverage: { reported: rows.filter(({ accounting }) => accounting !== null).length, eligible: rows.length },
        costEvidence,
        recordedCost: {
            totalUsd: costs.length === 0 ? null : addSettledUsd(...costs),
            reported: costs.filter((value) => value !== null).length, eligible: costs.length,
        },
        metrics: {
            passRate: graded.length === 0 ? null : successful.length / graded.length,
            medianCostPerSuccessfulTaskUsd: metric(successful.map(cost)),
            medianCostPerTaskUsd: metric(graded.map(cost)),
            medianCacheHitRatePerSuccessfulTask: metric(successful.map(({ accounting }) => accounting?.cacheEffectiveness?.cacheReadTokenRatio)),
            medianTimePerSuccessfulTaskMs: metric(successful.map(({ durationMs }) => durationMs)),
        },
    };
};

export const reportJob = (job: string) => {
    const rows: TaskReport[] = [];
    for (const entry of readdirSync(job, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const trial = join(job, entry.name);
        const record = readTrialDir(trial, { harness: "deepswe" });
        if (record === null) continue;
        const marker = join(trial, PUBLISHED_MARKER);
        const published = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
        const digestPath = published === "" ? null : join(published, "digest", "digest.json");
        const digest = digestPath !== null && existsSync(digestPath) ? json(digestPath) as DigestAccountingInput : null;
        const accounting = digest === null ? null : summarizeDigestAccounting(digest);
        const costEvidence: CostEvidence | null = digest === null ? null : { charged: 0, estimated: 0, unknown: 0 };
        if (costEvidence !== null) {
            for (const request of digest!.workspaces[0]!.accounting?.requests ?? []) {
                const kind = (request as { cost?: { kind?: string } }).cost?.kind;
                if (kind !== "charged" && kind !== "estimated" && kind !== "unknown") {
                    throw new TypeError(`${trial}: invalid request cost kind ${String(kind)}`);
                }
                costEvidence[kind]++;
            }
        }
        rows.push({
            task: record.taskId, reward: record.reward ?? null, outcome: record.outcome,
            durationMs: record.durationMs > 0 ? record.durationMs : null,
            evidence: published || trial, accounting, costEvidence,
        });
    }
    const state = json<{
        n_total_trials: number; updated_at?: string; finished_at?: string | null; stats: Record<string, unknown>;
    }>(join(job, "result.json"));
    return {
        job, totalTrials: state.n_total_trials,
        lastRunnerUpdate: state.updated_at ?? null, finishedAt: state.finished_at ?? null,
        runnerSnapshot: Object.fromEntries(Object.entries(state.stats).filter(([, value]) => typeof value === "number")),
        ...summarizeTasks(rows.toSorted((a, b) => a.task.localeCompare(b.task))),
    };
};

if (import.meta.main) {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: {
        json: { type: "boolean" }, baseline: { type: "string" }, profile: { type: "string" },
    } });
    if (positionals.length !== 1) throw new Error("usage: report.ts <job-directory> [--json]");
    if (Boolean(values.baseline) !== Boolean(values.profile)) throw new Error("--baseline and --profile are required together");
    const report = reportJob(resolve(positionals[0]!));
    const comparison = values.baseline === undefined ? undefined : compareBaseline(
        report.rows, json<{ rows: BaselineTrial[] }>(values.baseline).rows, values.profile!,
    );
    if (values.json) console.log(JSON.stringify({ ...report, comparison }, null, 2));
    else {
        for (const row of report.rows) {
            console.log(`${row.reward === 1 ? "PASS" : row.reward === 0 ? "FAIL" : "UNSCORED"} ${row.task} (${row.outcome}) — ${row.evidence}`);
        }
        console.log(`Pass rate: ${report.passed}/${report.graded} graded; ${report.totalTrials} trials planned; ${report.ungraded} ungraded finished records`);
        for (const [name, value] of Object.entries(report.metrics)) console.log(`${name}: ${JSON.stringify(value)}`);
        console.log(`Recorded USD (not necessarily billed): ${JSON.stringify(report.recordedCost)}`);
        console.log(`Request cost evidence: ${JSON.stringify(report.costEvidence)}`);
        console.log(`Runner's last saved state (${report.lastRunnerUpdate}; not a process-liveness check): ${JSON.stringify(report.runnerSnapshot)}`);
        if (comparison !== undefined) console.log(`Matched baseline comparison: ${JSON.stringify(comparison, null, 2)}`);
    }
}
