import test from "node:test";
import assert from "node:assert/strict";
import { addSettledUsd, cacheEffectivenessOf, summarizeDigestAccounting, summarizeRequiemAccounting, type ProviderUsageProjection } from "./accounting.ts";
import { bootstrapMean, holm, median, seededUniform, signFlipP } from "./statistics.ts";

// ─── accounting.test.ts ───
{
const request = (model: string, inputTokens = 75, cacheReadTokens = 5) => ({
    provider: "provider:fixture",
    model,
    outcome: "response",
    usage: { inputTokens, inputTokenDetails: { cacheReadTokens } },
    cost: {
        kind: "charged",
        amount: { amount: "0.1", currency: "USD" },
        source: "fixture",
    },
});

test("{§accounting-cost-completeness} bench accounting copies the one workspace's authoritative physical-request projection", () => {
    const requests = [request("provider/model"), request("provider/model")];
    assert.deepEqual(summarizeDigestAccounting({
        workspaces: [{
            accounting: {
                requests,
                usage: {
                    inputTokens: 150,
                    outputTokens: 30,
                    totalTokens: 180,
                    inputTokenDetails: { cacheReadTokens: 10 },
                    outputTokenDetails: { textTokens: 25, reasoningTokens: 5 },
                },
                costUsd: "0.031941728",
            },
        }],
        provider_requests: requests.map((accounting) => ({ kind: "emission", accounting })),
        turn_attempts: [{ accepted: true }, { accepted: false }],
    }), {
        providerRequests: 2,
        rejectedEmissions: 1,
        models: ["provider/model"],
        usage: {
            inputTokens: 150,
            outputTokens: 30,
            totalTokens: 180,
            inputTokenDetails: { cacheReadTokens: 10 },
            outputTokenDetails: { textTokens: 25, reasoningTokens: 5 },
        },
        cacheEffectiveness: {
            inputTokens: 150,
            cacheReadTokens: 10,
            cacheReadTokenRatio: 10 / 150,
        },
        costUsd: "0.031941728",
        knownCostUsd: "0.031941728",
        pricedRequests: 2,
        costEvidence: { charged: 2, estimated: 0, unknown: 0 },
    });
});

test("{§accounting-cost-completeness} an unsettled physical request remains cardinal while aggregate accounting stays unknown", () => {
    assert.deepEqual(summarizeDigestAccounting({
        workspaces: [{ accounting: null }],
        provider_requests: [{ kind: "emission", accounting: null }],
        turn_attempts: [{ accepted: null }],
    }), {
        providerRequests: 1,
        rejectedEmissions: 0,
        models: [],
        usage: null,
        cacheEffectiveness: null,
        costUsd: null,
        knownCostUsd: null,
        pricedRequests: 0,
        costEvidence: { charged: 0, estimated: 0, unknown: 1 },
    });
});

test("{§accounting-cost-completeness} settled usage-less requests do not turn a subtotal into complete spend", () => {
    const priced = request("provider/model");
    const unmetered = { model: "provider/child", cost: { kind: "unknown", reason: "interrupted before usage" } };
    const requests = [priced, unmetered];
    const summary = summarizeDigestAccounting({
        workspaces: [{ accounting: { requests, usage: priced.usage, costUsd: "0.1" } }],
        provider_requests: [{ kind: "emission", accounting: priced }, { kind: "bare", accounting: unmetered }],
        turn_attempts: [{ accepted: true }],
    });
    assert.equal(summary.costUsd, null);
    assert.equal(summary.knownCostUsd, "0.1");
    assert.equal(summary.pricedRequests, 1);
    assert.deepEqual(summary.costEvidence, { charged: 1, estimated: 0, unknown: 1 });
    const interview = summarizeRequiemAccounting({ sessions: [
        { accounting: { requests: [priced], usage: priced.usage, costUsd: "0.1" } },
        { accounting: { requests: [unmetered], usage: null, costUsd: null } },
    ] });
    assert.equal(interview.costUsd, null);
    assert.equal(interview.knownCostUsd, "0.1");
    assert.equal(interview.pricedRequests, 1);
});

test("{§accounting-cost-completeness} explicit incomplete totals retain their separate known subtotal", () => {
    const priced = request("provider/model");
    const requests = [priced, { model: "provider/model", cost: { kind: "unknown", reason: "Missing usage" } }];
    const accounting = { requests, usage: null, knownUsage: priced.usage, costUsd: null, knownCostUsd: "0.1" };
    const summary = summarizeDigestAccounting({
        workspaces: [{ accounting }],
        provider_requests: requests.map((accounting) => ({ kind: "emission", accounting })),
        turn_attempts: [],
    });
    assert.equal(summary.costUsd, null);
    assert.equal(summary.knownCostUsd, "0.1");
    assert.equal(summary.usage, null);
    const requiem = summarizeRequiemAccounting({ sessions: [{ accounting }] });
    assert.equal(requiem.costUsd, null);
    assert.equal(requiem.knownCostUsd, "0.1");
});

test("{§accounting-cost-completeness} estimates, explicit zero, and non-USD evidence retain their provenance", () => {
    for (const [cost, known, full, evidence, pricedRequests] of [
        [{ kind: "estimated", amount: { amount: "0.1", currency: "USD" }, source: "catalog" }, "0.1", "0.1", { charged: 0, estimated: 1, unknown: 0 }, 1],
        [{ kind: "charged", amount: { amount: "0", currency: "USD" }, source: "provider" }, "0", "0", { charged: 1, estimated: 0, unknown: 0 }, 1],
        [{ kind: "charged", amount: { amount: "3", currency: "EUR" }, source: "provider" }, null, null, { charged: 1, estimated: 0, unknown: 0 }, 0],
        [{ kind: "charged", amount: { amount: "3", currency: "EUR" }, usdEquivalent: "3.5", source: "provider" }, "3.5", "3.5", { charged: 1, estimated: 0, unknown: 0 }, 1],
    ] as const) {
        const item = { model: "provider/model", cost };
        const summary = summarizeDigestAccounting({
            workspaces: [{ accounting: { requests: [item], usage: null, costUsd: known } }],
            provider_requests: [{ kind: "emission", accounting: item }], turn_attempts: [],
        });
        assert.equal(summary.costUsd, full);
        assert.equal(summary.knownCostUsd, known);
        assert.equal(summary.pricedRequests, pricedRequests);
        assert.deepEqual(summary.costEvidence, evidence);
    }
});

test("{§accounting-cost-completeness} digest accounting rejects ambiguous scope and inconsistent source cardinality", () => {
    assert.throws(
        () => summarizeDigestAccounting({
            workspaces: [],
            provider_requests: [],
            turn_attempts: [],
        }),
        /exactly one workspace/,
    );
    assert.throws(
        () => summarizeDigestAccounting({
            workspaces: [{
                accounting: {
                    requests: [request("m")],
                    usage: { inputTokens: 1 },
                    costUsd: "0",
                },
            }],
            provider_requests: [],
            turn_attempts: [],
        }),
        /request count does not match/,
    );
});

test("{§accounting-cost-completeness} requiem composes session projections with exact decimals and unknown-field propagation", () => {
    assert.deepEqual(summarizeRequiemAccounting({
        sessions: [{
            accounting: {
                requests: [request("requiem-a", 10, 1)],
                usage: {
                    inputTokens: 10,
                    outputTokens: 2,
                    totalTokens: 12,
                    inputTokenDetails: { cacheReadTokens: 1 },
                    outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
                },
                costUsd: "0.1",
            },
        }, {
            accounting: {
                requests: [request("requiem-b", 20, 3)],
                usage: {
                    inputTokens: 20,
                    outputTokens: 4,
                    totalTokens: 24,
                    inputTokenDetails: { cacheReadTokens: 3 },
                    outputTokenDetails: { textTokens: 3 },
                },
                costUsd: "0.2",
            },
        }],
    }), {
        sessions: 2,
        providerRequests: 2,
        usage: {
            inputTokens: 30,
            outputTokens: 6,
            totalTokens: 36,
            inputTokenDetails: { cacheReadTokens: 4 },
            outputTokenDetails: { textTokens: 5 },
        },
        cacheEffectiveness: {
            inputTokens: 30,
            cacheReadTokens: 4,
            cacheReadTokenRatio: 4 / 30,
        },
        costUsd: "0.3",
        knownCostUsd: "0.3",
        pricedRequests: 2,
        costEvidence: { charged: 2, estimated: 0, unknown: 0 },
    });
    assert.equal(addSettledUsd("0.1", null), null);
    assert.equal(addSettledUsd("0.1", "0.2"), "0.3");
});

test("{§accounting-cost-completeness}: cache reporting is token-weighted, exact about zero, and rejects impossible evidence", () => {
    assert.deepEqual(cacheEffectivenessOf({
        inputTokens: 100,
        inputTokenDetails: { cacheReadTokens: 75, cacheWriteTokens: 10 },
    }), {
        inputTokens: 100,
        cacheReadTokens: 75,
        cacheWriteTokens: 10,
        cacheReadTokenRatio: 0.75,
    });

    assert.deepEqual(cacheEffectivenessOf({
        inputTokens: 0, inputTokenDetails: { cacheReadTokens: 0 },
    }), {
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheReadTokenRatio: null,
    });

    assert.throws(
        () => cacheEffectivenessOf({
            inputTokens: 4, inputTokenDetails: { cacheReadTokens: 5 },
        }),
        /cache-read tokens cannot exceed total input tokens/,
    );
});

test("{§accounting-cost-completeness} bench accounting rejects malformed token and exact-decimal evidence", () => {
    const malformed = {
        workspaces: [{
            accounting: {
                requests: [],
                usage: { inputTokens: "10" },
                costUsd: "0",
            },
        }],
        provider_requests: [],
        turn_attempts: [],
    } as unknown as Parameters<typeof summarizeDigestAccounting>[0];
    assert.throws(
        () => summarizeDigestAccounting(malformed),
        /usage\.inputTokens must be a non-negative safe integer/,
    );
    assert.throws(
        () => addSettledUsd("1e-3"),
        /canonical non-negative decimal string/,
    );
});
}

// ─── accounting-cache.test.ts ───
{
const request = (kind: string, usage?: ProviderUsageProjection) => ({
    kind,
    accounting: { model: "fixture", cost: { kind: "charged", amount: { amount: "0.1", currency: "USD" }, source: "fixture" }, ...(usage === undefined ? {} : { usage }) },
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

test("{§accounting-cost-completeness} cache and task accounting include every model request", () => {
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

test("{§accounting-cost-completeness} missing model evidence is unknown, never an excluded request", () => {
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

test("{§accounting-cost-completeness} unsettled evidence leaves task cost, usage and cache unknown", () => {
    const summary = summarizeDigestAccounting(digest([
        request("emission", cached(100, 80)),
        { kind: "bare", accounting: null },
    ]));
    assert.equal(summary.costUsd, null);
    assert.equal(summary.usage, null);
    assert.equal(summary.cacheEffectiveness, null);
});

test("{§accounting-cost-completeness} zero model input differs from no model requests", () => {
    assert.deepEqual(summarizeDigestAccounting(digest([
        request("emission", cached(0, 0)),
    ])).cacheEffectiveness, { inputTokens: 0, cacheReadTokens: 0, cacheReadTokenRatio: null });
    assert.equal(summarizeDigestAccounting(digest([])).cacheEffectiveness, null);
});

test("{§accounting-cost-completeness} validates each model request before aggregating", () => {
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

test("{§accounting-cost-completeness} cache writes require complete evidence while explicit misses count", () => {
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

test("{§accounting-cost-completeness} requiem cache also requires every physical request's evidence", () => {
    const summary = summarizeRequiemAccounting({ sessions: [{ accounting: {
        requests: [request("emission", cached(100, 80)).accounting, request("emission").accounting],
        usage: cached(100, 80),
        costUsd: "0.1",
    } }] });
    assert.equal(summary.cacheEffectiveness, null);
    assert.equal(summary.costUsd, "0.1");
});
}

// ─── statistics.test.ts ───
{
test("{§swebench-comparison} median: the middle value, the mean of the two middles, nothing from nothing", () => {
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("{§swebench-comparison} the generator is seeded: one seed draws one stream, so intervals are reproducible", () => {
    const first = seededUniform("x"); const second = seededUniform("x");
    const draws = Array.from({ length: 5 }, () => first());
    assert.deepEqual(Array.from({ length: 5 }, () => second()), draws);
    assert.ok(draws.every((value) => value >= 0 && value < 1));
    const values = Array.from({ length: 30 }, (_, index) => index % 2);
    const one = bootstrapMean(values, 2_000, seededUniform("ci"));
    assert.deepEqual(bootstrapMean(values, 2_000, seededUniform("ci")), one);
    assert.equal(one.mean, 0.5);
    assert.ok(one.low < 0.5 && 0.5 < one.high, `the interval brackets the mean: ${one.low}–${one.high}`);
    assert.ok(one.low > 0.25 && one.high < 0.75, "thirty coin flips do not admit an interval wider than a quarter each side");
    const flat = bootstrapMean([0.4, 0.4, 0.4], 200, seededUniform("flat"));
    assert.ok([flat.low, flat.mean, flat.high].every((value) => Math.abs(value - 0.4) < 1e-12), "identical tasks have no sampling variance");
    assert.throws(() => bootstrapMean([], 10, seededUniform("e")), /no values/u);
});

test("{§swebench-comparison} the paired test: no difference reads as p = 1, a uniform difference as significant, and Holm is step-down", () => {
    assert.equal(signFlipP([0, 0, 0], 100, seededUniform("z")), 1);
    assert.equal(signFlipP([], 100, seededUniform("z")), 1);
    assert.ok(signFlipP(Array.from({ length: 30 }, () => 1 / 3), 2_000, seededUniform("s")) < 0.01);
    assert.deepEqual(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
    assert.deepEqual(holm([0.5]), [0.5]);
    assert.deepEqual(holm([0.4, 0.4]), [0.8, 0.8], "a corrected p never exceeds one and never falls below an earlier rank");
});
}
