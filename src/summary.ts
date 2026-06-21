// Streaming aggregation over BenchRecords — the summarization primitive every
// harness shares (objective 4). Fold records in as runs complete (`add`), read
// the report on demand (`report`). Stateful by design, hence a class: a long
// campaign streams thousands of records past without holding a parallel array
// anywhere but here.

import type { BenchRecord, Outcome } from "./record.ts";

export interface Quantiles {
    mean: number;
    p50: number;
    p95: number;
    total: number;
}

export interface BenchSummary {
    total: number;
    passed: number;
    passRate: number;                       // passed / total, 0 when empty
    byOutcome: Record<Outcome, number>;
    byStatus: Record<string, number>;
    durationMs: Quantiles;
    totalTokens: Quantiles;
}

// Nearest-rank percentile over an ascending-sorted array. p in [0,1].
const percentile = (sorted: readonly number[], p: number): number => {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil(p * sorted.length);
    return sorted[Math.min(rank, sorted.length) - 1];
};

const quantiles = (values: number[]): Quantiles => {
    const sorted = values.toSorted((a, b) => a - b);
    const total = sorted.reduce((sum, v) => sum + v, 0);
    return {
        mean: sorted.length === 0 ? 0 : total / sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        total,
    };
};

export default class Summary {
    #records: BenchRecord[] = [];

    add(record: BenchRecord): this {
        this.#records.push(record);
        return this;
    }

    addAll(records: Iterable<BenchRecord>): this {
        for (const r of records) this.#records.push(r);
        return this;
    }

    get size(): number {
        return this.#records.length;
    }

    report(): BenchSummary {
        const records = this.#records;
        const byOutcome: Record<Outcome, number> = { pass: 0, fail: 0, error: 0, timeout: 0, cancelled: 0 };
        const byStatus: Record<string, number> = {};
        for (const { outcome, status } of records) {
            byOutcome[outcome] += 1;
            byStatus[status] = (byStatus[status] ?? 0) + 1;
        }
        return {
            total: records.length,
            passed: byOutcome.pass,
            passRate: records.length === 0 ? 0 : byOutcome.pass / records.length,
            byOutcome,
            byStatus,
            durationMs: quantiles(records.map((r) => r.durationMs)),
            totalTokens: quantiles(records.map((r) => r.usage.totalTokens)),
        };
    }
}
