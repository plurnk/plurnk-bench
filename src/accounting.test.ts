import test from "node:test";
import assert from "node:assert/strict";
import {
    addSettledUsd,
    summarizeDigestAccounting,
    summarizeRequiemAccounting,
} from "./accounting.ts";

test("bench accounting consumes the daemon aggregate emitted by the released digest", () => {
    assert.deepEqual(summarizeDigestAccounting({
        workspaces: [{ cost_usd: 0.031941728 }],
        turn_attempts: [
            {
                accepted: true,
                model: "fireworks/model",
                usage_prompt: 100,
                usage_completion: 20,
                usage_reasoning: 5,
                usage_cached: 10,
            },
            {
                accepted: false,
                model: "fireworks/model",
                usage_prompt: 50,
                usage_completion: 10,
                usage_reasoning: 0,
                usage_cached: 0,
            },
        ],
    }), {
        providerAttempts: 2,
        rejectedAttempts: 1,
        models: ["fireworks/model"],
        prompt: 150,
        completion: 30,
        reasoning: 5,
        cached: 10,
        costUsd: 0.031941728,
    });
});

test("pending money remains unknown and an error call is not mislabeled as a rejected response", () => {
    assert.deepEqual(summarizeDigestAccounting({
        workspaces: [{ cost_usd: null }],
        turn_attempts: [{
            accepted: null,
            model: "fireworks/model",
            usage_prompt: null,
            usage_completion: null,
            usage_reasoning: null,
            usage_cached: null,
        }],
    }), {
        providerAttempts: 1,
        rejectedAttempts: 0,
        models: ["fireworks/model"],
        prompt: 0,
        completion: 0,
        reasoning: 0,
        cached: 0,
        costUsd: null,
    });
});

test("requiem and total accounting never coerce missing charges to zero", () => {
    assert.deepEqual(summarizeRequiemAccounting({
        workers: [{
            usage: { prompt: 10, completion: 2, reasoning: 1, cached: 0, total: 13 },
            costUsd: null,
        }],
    }), {
        workers: 1,
        usage: { prompt: 10, completion: 2, reasoning: 1, cached: 0, total: 13 },
        costUsd: null,
    });
    assert.equal(addSettledUsd(0.1, null), null);
    assert.equal(addSettledUsd(0.1, 0.2), 0.30000000000000004);
    assert.throws(() => addSettledUsd(Number.NaN), /non-negative number or null/);
});

test("bench accounting rejects malformed provider token evidence", () => {
    const digest = {
        workspaces: [{ cost_usd: 0 }],
        turn_attempts: [{
            accepted: true,
            model: "provider/model",
            usage_prompt: "10",
            usage_completion: 2,
            usage_reasoning: 1,
            usage_cached: 0,
        }],
    } as unknown as Parameters<typeof summarizeDigestAccounting>[0];
    assert.throws(() => summarizeDigestAccounting(digest), /usage_prompt must be a non-negative safe integer or null/);

    const requiem = {
        workers: [{
            usage: { prompt: 10, completion: Number.NaN, reasoning: 1, cached: 0, total: 13 },
            costUsd: 0,
        }],
    };
    assert.throws(() => summarizeRequiemAccounting(requiem), /usage\.completion must be a non-negative safe integer/);
});
