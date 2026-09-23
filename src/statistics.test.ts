import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapMean, holm, median, seededUniform, signFlipP } from "./statistics.ts";

test("median: the middle value, the mean of the two middles, nothing from nothing", () => {
    assert.equal(median([]), null);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("[§swebench-comparison] the generator is seeded: one seed draws one stream, so intervals are reproducible", () => {
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

test("[§swebench-comparison] the paired test: no difference reads as p = 1, a uniform difference as significant, and Holm is step-down", () => {
    assert.equal(signFlipP([0, 0, 0], 100, seededUniform("z")), 1);
    assert.equal(signFlipP([], 100, seededUniform("z")), 1);
    assert.ok(signFlipP(Array.from({ length: 30 }, () => 1 / 3), 2_000, seededUniform("s")) < 0.01);
    assert.deepEqual(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
    assert.deepEqual(holm([0.5]), [0.5]);
    assert.deepEqual(holm([0.4, 0.4]), [0.8, 0.8], "a corrected p never exceeds one and never falls below an earlier rank");
});
