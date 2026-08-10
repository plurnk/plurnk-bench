export interface DigestAccountingInput {
    workspaces: Array<{ cost_usd: number | null }>;
    turn_attempts: Array<{
        accepted: boolean | null;
        model: string;
        usage_prompt: number | null;
        usage_completion: number | null;
        usage_reasoning: number | null;
        usage_cached: number | null;
    }>;
}

export interface AccountingSummary {
    providerAttempts: number;
    rejectedAttempts: number;
    models: string[];
    prompt: number;
    completion: number;
    reasoning: number;
    cached: number;
    costUsd: number | null;
}

const settledUsd = (value: unknown, subject: string): number | null => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative number or null`);
    }
    return value;
};

const observedTokens = (value: unknown, subject: string, nullAsZero = false): number => {
    if (value === null && nullAsZero) return 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer${nullAsZero ? " or null" : ""}`);
    }
    return value;
};

const sumSettledUsd = (values: readonly (number | null)[]): number | null =>
    values.some((value) => value === null)
        ? null
        : values.reduce<number>((sum, value) => sum + value!, 0);

export const summarizeDigestAccounting = (digest: DigestAccountingInput): AccountingSummary => {
    const attempts = digest.turn_attempts;
    return {
        providerAttempts: attempts.length,
        rejectedAttempts: attempts.filter((attempt) => attempt.accepted === false).length,
        models: [...new Set(attempts.map((attempt) => attempt.model))].toSorted(),
        prompt: attempts.reduce((sum, attempt, index) =>
            sum + observedTokens(attempt.usage_prompt, `provider attempt ${index} usage_prompt`, true), 0),
        completion: attempts.reduce((sum, attempt, index) =>
            sum + observedTokens(attempt.usage_completion, `provider attempt ${index} usage_completion`, true), 0),
        reasoning: attempts.reduce((sum, attempt, index) =>
            sum + observedTokens(attempt.usage_reasoning, `provider attempt ${index} usage_reasoning`, true), 0),
        cached: attempts.reduce((sum, attempt, index) =>
            sum + observedTokens(attempt.usage_cached, `provider attempt ${index} usage_cached`, true), 0),
        costUsd: sumSettledUsd(digest.workspaces.map((workspace, index) =>
            settledUsd(workspace.cost_usd, `workspace ${index} cost_usd`))),
    };
};

export interface RequiemAccountingInput {
    workers: Array<{
        usage: {
            prompt: number;
            completion: number;
            reasoning: number;
            cached: number;
            total: number;
        };
        costUsd: number | null;
    }>;
}

export const summarizeRequiemAccounting = (report: RequiemAccountingInput): Record<string, unknown> => {
    if (!Array.isArray(report.workers)) throw new TypeError("requiem accounting has no workers array");
    const workers = report.workers;
    return {
        workers: workers.length,
        usage: workers.reduce((total, worker, index) => ({
            prompt: total.prompt + observedTokens(worker.usage.prompt, `requiem worker ${index} usage.prompt`),
            completion: total.completion + observedTokens(worker.usage.completion, `requiem worker ${index} usage.completion`),
            reasoning: total.reasoning + observedTokens(worker.usage.reasoning, `requiem worker ${index} usage.reasoning`),
            cached: total.cached + observedTokens(worker.usage.cached, `requiem worker ${index} usage.cached`),
            total: total.total + observedTokens(worker.usage.total, `requiem worker ${index} usage.total`),
        }), { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 }),
        costUsd: sumSettledUsd(workers.map((worker, index) =>
            settledUsd(worker.costUsd, `requiem worker ${index} costUsd`))),
    };
};

export const addSettledUsd = (...values: Array<number | null>): number | null =>
    sumSettledUsd(values.map((value, index) => settledUsd(value, `USD value ${index}`)));
