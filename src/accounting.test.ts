import test from "node:test";
import assert from "node:assert/strict";
import {
    addSettledUsd,
    summarizeDigestAccounting,
    summarizeRequiemAccounting,
} from "./accounting.ts";

const request = (model: string) => ({
    provider: "provider:fixture",
    model,
    outcome: "response",
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
        provider_requests: requests.map((accounting) => ({ accounting })),
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
        costUsd: "0.031941728",
    });
});

test("an unsettled physical request remains cardinal while aggregate accounting stays unknown", () => {
    assert.deepEqual(summarizeDigestAccounting({
        workspaces: [{ accounting: null }],
        provider_requests: [{ accounting: null }],
        turn_attempts: [{ accepted: null }],
    }), {
        providerRequests: 1,
        rejectedEmissions: 0,
        models: [],
        usage: null,
        costUsd: null,
    });
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
                requests: [request("requiem-a")],
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
                requests: [request("requiem-b")],
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
        costUsd: "0.3",
    });
    assert.equal(addSettledUsd("0.1", null), null);
    assert.equal(addSettledUsd("0.1", "0.2"), "0.3");
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
