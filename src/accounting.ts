export interface ProviderUsageProjection {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokenDetails?: {
        noCacheTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    };
    outputTokenDetails?: {
        textTokens?: number;
        reasoningTokens?: number;
    };
}

// Deliberately narrow views of the contracts-owned accounting shapes. Bench
// preserves request evidence verbatim and consumes only the aggregate projection;
// it does not normalize provider responses or calculate provider charges.
export interface ProviderAccountingProjection {
    requests: readonly unknown[];
    usage: ProviderUsageProjection | null;
    costUsd: string | null;
}

interface ProviderRequestProjection {
    model: string;
}

export interface DigestAccountingInput {
    workspaces: Array<{ accounting: ProviderAccountingProjection | null }>;
    provider_requests: Array<{ accounting: ProviderRequestProjection | null }>;
    turn_attempts: Array<{ accepted: boolean | null }>;
}

export interface AccountingSummary {
    providerRequests: number;
    rejectedEmissions: number;
    models: string[];
    usage: ProviderUsageProjection | null;
    costUsd: string | null;
}

export interface RequiemAccountingInput {
    workers: Array<{ accounting: ProviderAccountingProjection }>;
}

export interface RequiemAccountingSummary {
    workers: number;
    providerRequests: number;
    usage: ProviderUsageProjection | null;
    costUsd: string | null;
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const recordOf = (value: unknown, subject: string): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`${subject} must be an object`);
    }
    return value as Record<string, unknown>;
};

const observedTokens = (value: unknown, subject: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError(`${subject} must be a non-negative safe integer`);
    }
    return value as number;
};

const settledUsd = (value: unknown, subject: string): string | null => {
    if (value === null) return null;
    if (typeof value !== "string" || !DECIMAL.test(value)) {
        throw new TypeError(`${subject} must be a canonical non-negative decimal string or null`);
    }
    return value;
};

export const assertProviderUsageProjection = (
    value: unknown,
    subject: string,
): ProviderUsageProjection => {
    const usage = recordOf(value, subject);
    observedTokens(usage.inputTokens, `${subject}.inputTokens`);
    observedTokens(usage.outputTokens, `${subject}.outputTokens`);
    observedTokens(usage.totalTokens, `${subject}.totalTokens`);
    if (usage.inputTokenDetails !== undefined) {
        const details = recordOf(usage.inputTokenDetails, `${subject}.inputTokenDetails`);
        observedTokens(details.noCacheTokens, `${subject}.inputTokenDetails.noCacheTokens`);
        observedTokens(details.cacheReadTokens, `${subject}.inputTokenDetails.cacheReadTokens`);
        observedTokens(details.cacheWriteTokens, `${subject}.inputTokenDetails.cacheWriteTokens`);
    }
    if (usage.outputTokenDetails !== undefined) {
        const details = recordOf(usage.outputTokenDetails, `${subject}.outputTokenDetails`);
        observedTokens(details.textTokens, `${subject}.outputTokenDetails.textTokens`);
        observedTokens(details.reasoningTokens, `${subject}.outputTokenDetails.reasoningTokens`);
    }
    return value as ProviderUsageProjection;
};

export const assertProviderAccountingProjection = (
    value: unknown,
    subject: string,
): ProviderAccountingProjection => {
    const accounting = recordOf(value, subject);
    if (!Array.isArray(accounting.requests)) {
        throw new TypeError(`${subject}.requests must be an array`);
    }
    if (accounting.usage !== null) {
        assertProviderUsageProjection(accounting.usage, `${subject}.usage`);
    }
    settledUsd(accounting.costUsd, `${subject}.costUsd`);
    return value as unknown as ProviderAccountingProjection;
};

const providerModel = (value: unknown, subject: string): string => {
    const request = recordOf(value, subject);
    if (typeof request.model !== "string" || request.model.trim() === "") {
        throw new TypeError(`${subject}.model must be a non-empty string`);
    }
    return request.model;
};

const acceptedEmission = (value: unknown, subject: string): boolean | null => {
    if (value !== true && value !== false && value !== null) {
        throw new TypeError(`${subject}.accepted must be boolean or null`);
    }
    return value;
};

export const summarizeDigestAccounting = (digest: DigestAccountingInput): AccountingSummary => {
    if (!Array.isArray(digest.workspaces) || digest.workspaces.length !== 1) {
        throw new TypeError("bench digest accounting requires exactly one workspace");
    }
    if (!Array.isArray(digest.provider_requests)) {
        throw new TypeError("bench digest accounting has no provider_requests array");
    }
    if (!Array.isArray(digest.turn_attempts)) {
        throw new TypeError("bench digest accounting has no turn_attempts array");
    }

    const workspaceAccounting = digest.workspaces[0]!.accounting;
    const requestModels = digest.provider_requests.map((request, index) =>
        request.accounting === null
            ? null
            : providerModel(request.accounting, `provider request ${index} accounting`));
    if (workspaceAccounting === null) {
        if (!digest.provider_requests.some((request) => request.accounting === null)) {
            throw new TypeError("workspace accounting is null without an unsettled provider request");
        }
    } else {
        const accounting = assertProviderAccountingProjection(
            workspaceAccounting,
            "workspace accounting",
        );
        if (accounting.requests.length !== digest.provider_requests.length) {
            throw new TypeError("workspace accounting request count does not match provider_requests");
        }
        if (requestModels.some((model) => model === null)) {
            throw new TypeError("settled workspace accounting contains an unsettled provider request");
        }
    }
    const rejectedEmissions = digest.turn_attempts.filter((attempt, index) =>
        acceptedEmission(attempt.accepted, `turn attempt ${index}`) === false).length;
    return {
        providerRequests: digest.provider_requests.length,
        rejectedEmissions,
        models: [...new Set(requestModels.filter((model): model is string => model !== null))].toSorted(),
        usage: workspaceAccounting?.usage ?? null,
        costUsd: workspaceAccounting?.costUsd ?? null,
    };
};

const sumKnown = (
    accountings: readonly ProviderAccountingProjection[],
    read: (usage: ProviderUsageProjection) => number | undefined,
): number | undefined => {
    const values = accountings.map((accounting) => accounting.usage === null
        ? undefined
        : read(accounting.usage));
    if (values.some((value) => value === undefined)) return undefined;
    return observedTokens(
        (values as number[]).reduce((sum, value) => sum + value, 0),
        "aggregate provider usage",
    );
};

const aggregateUsage = (
    accountings: readonly ProviderAccountingProjection[],
): ProviderUsageProjection | null => {
    const inputTokens = sumKnown(accountings, (usage) => usage.inputTokens);
    const outputTokens = sumKnown(accountings, (usage) => usage.outputTokens);
    const totalTokens = sumKnown(accountings, (usage) => usage.totalTokens);
    const noCacheTokens = sumKnown(accountings, (usage) => usage.inputTokenDetails?.noCacheTokens);
    const cacheReadTokens = sumKnown(accountings, (usage) => usage.inputTokenDetails?.cacheReadTokens);
    const cacheWriteTokens = sumKnown(accountings, (usage) => usage.inputTokenDetails?.cacheWriteTokens);
    const textTokens = sumKnown(accountings, (usage) => usage.outputTokenDetails?.textTokens);
    const reasoningTokens = sumKnown(accountings, (usage) => usage.outputTokenDetails?.reasoningTokens);
    const inputTokenDetails = noCacheTokens === undefined
        && cacheReadTokens === undefined && cacheWriteTokens === undefined
        ? undefined
        : {
            ...(noCacheTokens === undefined ? {} : { noCacheTokens }),
            ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
            ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        };
    const outputTokenDetails = textTokens === undefined && reasoningTokens === undefined
        ? undefined
        : {
            ...(textTokens === undefined ? {} : { textTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        };
    if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined
        && inputTokenDetails === undefined && outputTokenDetails === undefined) return null;
    return assertProviderUsageProjection({
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(totalTokens === undefined ? {} : { totalTokens }),
        ...(inputTokenDetails === undefined ? {} : { inputTokenDetails }),
        ...(outputTokenDetails === undefined ? {} : { outputTokenDetails }),
    }, "requiem aggregate usage");
};

const canonicalDecimal = (coefficient: bigint, scale: number): string => {
    const digits = String(coefficient).padStart(scale + 1, "0");
    if (scale === 0) return digits;
    const integer = digits.slice(0, -scale);
    const fraction = digits.slice(-scale).replace(/0+$/, "");
    return fraction.length === 0 ? integer : `${integer}.${fraction}`;
};

export const addSettledUsd = (...values: Array<string | null>): string | null => {
    const settled = values.map((value, index) => settledUsd(value, `USD value ${index}`));
    if (settled.some((value) => value === null)) return null;
    const parts = (settled as string[]).map((value) => {
        const [integer, fraction = ""] = value.split(".");
        return { coefficient: BigInt(`${integer}${fraction}`), scale: fraction.length };
    });
    const scale = Math.max(0, ...parts.map((part) => part.scale));
    const coefficient = parts.reduce(
        (sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale),
        0n,
    );
    return canonicalDecimal(coefficient, scale);
};

export const summarizeRequiemAccounting = (
    report: RequiemAccountingInput,
): RequiemAccountingSummary => {
    if (!Array.isArray(report.workers)) {
        throw new TypeError("requiem accounting has no workers array");
    }
    const accountings = report.workers.map((worker, index) =>
        assertProviderAccountingProjection(worker.accounting, `requiem worker ${index} accounting`));
    return {
        workers: accountings.length,
        providerRequests: accountings.reduce((sum, accounting) => sum + accounting.requests.length, 0),
        usage: aggregateUsage(accountings),
        costUsd: addSettledUsd(...accountings.map(({ costUsd }) => costUsd)),
    };
};
