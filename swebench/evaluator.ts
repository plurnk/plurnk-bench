// SPEC §swebench-evaluator. Pure adaptation of the OFFICIAL SWE-bench harness's
// per-instance report into the shared RewardJson shape (src/ingest.ts), so the family
// reuses the core join and publication unchanged. The harness owns grading; the bench
// owns only this translation.

import { join } from "node:path";
import type { RewardJson } from "../src/ingest.ts";

export interface SweTestsStatus {
    readonly success: readonly string[];
    readonly failure: readonly string[];
}

export interface SweInstanceReport {
    readonly patch_is_None?: boolean;
    readonly patch_exists?: boolean;
    readonly patch_successfully_applied?: boolean;
    readonly resolved?: boolean;
    readonly infra_failure?: boolean;
    readonly tests_status?: {
        readonly FAIL_TO_PASS?: SweTestsStatus;
        readonly PASS_TO_PASS?: SweTestsStatus;
    };
}

export interface Prediction {
    readonly instance_id: string;
    readonly model_name_or_path: string;
    readonly model_patch: string;
}

// The harness writes its AGGREGATE report to <reportDir>/<modelLabel>.<runId>.json and
// each instance's own report under
// <reportDir>/logs/run_evaluation/<runId>/<modelLabel>/<instance>/report.json.
export const aggregateReportPath = (reportDir: string, runId: string, modelLabel: string): string =>
    join(reportDir, `${modelLabel}.${runId}.json`);

export const instanceReportPath = (reportDir: string, runId: string, modelLabel: string, instance: string): string =>
    join(reportDir, "logs", "run_evaluation", runId, modelLabel, instance, "report.json");

const tally = (status: SweTestsStatus | undefined): { total: number; passed: number } => ({
    total: (status?.success.length ?? 0) + (status?.failure.length ?? 0),
    passed: status?.success.length ?? 0,
});

// §swebench-evaluator. Translate one instance's harness report into the core RewardJson.
// `null` means NO oracle verdict — the report is absent, or the harness recorded an
// infrastructure failure — and is preserved as absence, never scored as 0.
export const rewardFromInstanceReport = (report: SweInstanceReport | null | undefined): RewardJson | null => {
    if (report === undefined || report === null || report.infra_failure === true) return null;
    const f2p = tally(report.tests_status?.FAIL_TO_PASS);
    const p2p = tally(report.tests_status?.PASS_TO_PASS);
    const reward: RewardJson = { reward: report.resolved === true ? 1 : 0 };
    if (f2p.total + p2p.total > 0) reward.partial = (f2p.passed + p2p.passed) / (f2p.total + p2p.total);
    if (f2p.total > 0) {
        reward.f2p_total = f2p.total;
        reward.f2p_passed = f2p.passed;
    }
    if (p2p.total > 0) {
        reward.p2p_total = p2p.total;
        reward.p2p_passed = p2p.passed;
    }
    if (report.patch_successfully_applied === false) reward.apply_failed = 1;
    return reward;
};

// The harness's predictions file: one JSON object per instance, nothing else.
export const predictionsJsonl = (predictions: readonly Prediction[]): string =>
    predictions.length === 0 ? "" : predictions.map((p) => JSON.stringify(p)).join("\n") + "\n";
