import test from "node:test";
import assert from "node:assert/strict";
import { rankBySeed, repoCounts, stratifiedDraw, uniformDraw } from "./sample.ts";

const ids = Array.from({ length: 20 }, (_, index) => `r${index % 4}__x-${index}`);
const repoOf = (id: string): string => id.split("__")[0]!;

test("[§swebench-corpus] the draw order is deterministic for one seed and a permutation of the corpus", () => {
    assert.deepEqual(rankBySeed(ids, "a"), rankBySeed(ids, "a"));
    assert.notDeepEqual(rankBySeed(ids, "a"), rankBySeed(ids, "b"), "a different seed reorders the draw");
    assert.deepEqual([...rankBySeed(ids, "a")].sort(), [...ids].sort(), "no instance is invented or lost");
});

test("[§swebench-corpus] a uniform draw returns exactly count distinct instances, sorted", () => {
    const draw = uniformDraw(ids, "s", 8);
    assert.equal(draw.length, 8);
    assert.equal(new Set(draw).size, 8);
    assert.deepEqual(draw, [...draw].sort());
});

test("[§swebench-corpus] a stratified draw spreads across every repo before doubling up", () => {
    const draw = stratifiedDraw(ids, repoOf, "s", 8);
    assert.equal(draw.length, 8);
    assert.deepEqual(Object.values(repoCounts(draw, repoOf)), [2, 2, 2, 2], "eight across four repos is two each");
});
