import test from "node:test";
import assert from "node:assert/strict";
import {
    addSettledUsd,
    cacheEffectivenessOf,
    summarizeDigestAccounting,
    summarizeRequiemAccounting,
} from "./accounting.ts";

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

test("bench accounting copies the one workspace's authoritative physical-request projection", () => {
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

test("an unsettled physical request remains cardinal while aggregate accounting stays unknown", () => {
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
    const interview = summarizeRequiemAccounting({ workers: [
        { accounting: { requests: [priced], usage: priced.usage, costUsd: "0.1" } },
        { accounting: { requests: [unmetered], usage: null, costUsd: null } },
    ] });
    assert.equal(interview.costUsd, null);
    assert.equal(interview.knownCostUsd, "0.1");
    assert.equal(interview.pricedRequests, 1);
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

test("digest accounting rejects ambiguous scope and inconsistent source cardinality", () => {
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

test("requiem composes worker projections with exact decimals and unknown-field propagation", () => {
    assert.deepEqual(summarizeRequiemAccounting({
        workers: [{
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
        workers: 2,
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

test("{§accounting-cache-effectiveness}: cache reporting is token-weighted, exact about zero, and rejects impossible evidence", () => {
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

test("bench accounting rejects malformed token and exact-decimal evidence", () => {
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
