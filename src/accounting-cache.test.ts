import test from "node:test";
import assert from "node:assert/strict";
import { summarizeDigestAccounting, summarizeRequiemAccounting } from "./accounting.ts";
import type { ProviderUsageProjection } from "./accounting.ts";

const request = (kind: string, usage?: ProviderUsageProjection) => ({
    kind,
    accounting: { model: "fixture", ...(usage === undefined ? {} : { usage }) },
});

const cached = (inputTokens: number, cacheReadTokens: number): ProviderUsageProjection => ({
    inputTokens,
    inputTokenDetails: { cacheReadTokens },
});

const digest = (requests: Array<{
    kind: string;
    accounting: { model: string; usage?: ProviderUsageProjection } | null;
}>) => ({
    workspaces: [{ accounting: requests.some(({ accounting }) => accounting === null) ? null : {
        requests: requests.map(({ accounting }) => accounting),
        usage: cached(350, 220),
        costUsd: "12.34",
    } }],
    provider_requests: requests,
    turn_attempts: [{ accepted: false }, { accepted: true }],
});

test("{§accounting-cache-effectiveness} cache and task accounting include every model request", () => {
    const evidence = digest([
        request("emission", cached(100, 80)),
        request("emission", cached(200, 100)),
        request("bare", cached(50, 40)),
    ]);
    const summary = summarizeDigestAccounting(evidence);
    assert.deepEqual(summary.cacheEffectiveness, {
        inputTokens: 350,
        cacheReadTokens: 220,
        cacheReadTokenRatio: 220 / 350,
    });
    assert.equal(summary.usage, evidence.workspaces[0]!.accounting!.usage);
    assert.equal(summary.costUsd, "12.34");
    assert.equal(summary.providerRequests, 3);
    assert.equal(summary.rejectedEmissions, 1);
});

test("{§accounting-cache-effectiveness} missing model evidence is unknown, never an excluded request", () => {
    for (const missing of [
        request("bare"),
        request("emission", { inputTokens: 100 }),
        request("emission", { inputTokenDetails: { cacheReadTokens: 10 } }),
        { kind: "emission", accounting: null },
    ]) {
        assert.equal(summarizeDigestAccounting(digest([
            request("emission", cached(100, 80)), missing,
        ])).cacheEffectiveness, null);
    }
});

test("{§accounting-cache-effectiveness} unsettled evidence leaves task cost, usage and cache unknown", () => {
    const summary = summarizeDigestAccounting(digest([
        request("emission", cached(100, 80)),
        { kind: "bare", accounting: null },
    ]));
    assert.equal(summary.costUsd, null);
    assert.equal(summary.usage, null);
    assert.equal(summary.cacheEffectiveness, null);
});

test("{§accounting-cache-effectiveness} zero model input differs from no model requests", () => {
    assert.deepEqual(summarizeDigestAccounting(digest([
        request("emission", cached(0, 0)),
    ])).cacheEffectiveness, { inputTokens: 0, cacheReadTokens: 0, cacheReadTokenRatio: null });
    assert.equal(summarizeDigestAccounting(digest([])).cacheEffectiveness, null);
});

test("{§accounting-cache-effectiveness} validates each model request before aggregating", () => {
    assert.throws(() => summarizeDigestAccounting(digest([
        request("emission", cached(100, 0)),
        request("bare", cached(1, 2)),
    ])), /cache-read tokens cannot exceed total input tokens/);
    assert.throws(() => summarizeDigestAccounting(digest([
        request("unrecognized", cached(100, 80)),
    ])), /unknown provider request kind/);
    assert.throws(() => summarizeDigestAccounting(digest([
        request("emission", cached(Number.MAX_SAFE_INTEGER, 0)),
        request("emission", cached(1, 0)),
    ])), /aggregate cache tokens must be a non-negative safe integer/);
});

test("{§accounting-cache-effectiveness} cache writes require complete evidence while explicit misses count", () => {
    const written = (cacheWriteTokens?: number) => request("emission", {
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 0, ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) },
    });
    assert.deepEqual(summarizeDigestAccounting(digest([
        written(5), written(10),
    ])).cacheEffectiveness, {
        inputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 15, cacheReadTokenRatio: 0,
    });
    assert.deepEqual(summarizeDigestAccounting(digest([
        written(5), written(),
    ])).cacheEffectiveness, {
        inputTokens: 200, cacheReadTokens: 0, cacheReadTokenRatio: 0,
    });
});

test("{§accounting-cache-effectiveness} requiem cache also requires every physical request's evidence", () => {
    const summary = summarizeRequiemAccounting({ workers: [{ accounting: {
        requests: [request("emission", cached(100, 80)).accounting, request("emission").accounting],
        usage: cached(100, 80),
        costUsd: "0.1",
    } }] });
    assert.equal(summary.cacheEffectiveness, null);
    assert.equal(summary.costUsd, "0.1");
});
