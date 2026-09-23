// Shared statistics: medians for the sheets, and the seeded resampling the SWE-bench comparison
// declares ({§swebench-comparison}). The generator is ours (a hash-seeded splitmix32), so one
// seed reads the same intervals on every machine and no library stream can drift beneath a sheet.

import { createHash } from "node:crypto";

export interface Interval { readonly mean: number; readonly low: number; readonly high: number }

export const median = (values: readonly number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = values.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export const mean = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0) / values.length;

export const seededUniform = (seed: string): (() => number) => {
    let state = createHash("sha256").update(seed).digest().readUInt32LE(0);
    return () => {
        state = (state + 0x9e3779b9) >>> 0;
        let z = state;
        z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
        z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
        z = (z ^ (z >>> 15)) >>> 0;
        return z / 4_294_967_296;
    };
};

// Percentile interval of the mean over `resamples` draws with replacement.
export const bootstrapMean = (values: readonly number[], resamples: number, next: () => number): Interval => {
    if (values.length === 0) throw new Error("bootstrapMean: no values");
    const means: number[] = [];
    for (let draw = 0; draw < resamples; draw += 1) {
        let total = 0;
        for (let pick = 0; pick < values.length; pick += 1) total += values[Math.floor(next() * values.length)]!;
        means.push(total / values.length);
    }
    means.sort((left, right) => left - right);
    return { mean: mean(values), low: means[Math.floor(0.025 * (resamples - 1))]!, high: means[Math.ceil(0.975 * (resamples - 1))]! };
};

// Two-sided sign-flip permutation p-value of a paired mean difference, Monte Carlo with the
// customary +1 so an observed extreme never reads as zero.
export const signFlipP = (diffs: readonly number[], resamples: number, next: () => number): number => {
    if (diffs.length === 0) return 1;
    const observed = Math.abs(mean(diffs));
    let atLeast = 0;
    for (let draw = 0; draw < resamples; draw += 1) {
        let total = 0;
        for (const diff of diffs) total += next() < 0.5 ? diff : -diff;
        if (Math.abs(total / diffs.length) >= observed - 1e-12) atLeast += 1;
    }
    return (atLeast + 1) / (resamples + 1);
};

// Holm step-down, index-aligned with the input.
export const holm = (ps: readonly number[]): number[] => {
    const order = ps.map((p, index) => ({ p, index })).toSorted((left, right) => left.p - right.p);
    const adjusted = new Array<number>(ps.length);
    let running = 0;
    order.forEach(({ p, index }, rank) => {
        running = Math.max(running, Math.min(1, (ps.length - rank) * p));
        adjusted[index] = running;
    });
    return adjusted;
};
