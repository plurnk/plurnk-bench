import test from "node:test";
import assert from "node:assert/strict";
import { citedInstances, rankBySeed, repoCounts, stratifiedDraw, uniformDraw } from "./sample.ts";

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

test("[§swebench-corpus] a cited corpus is taken verbatim and sorted, never drawn", () => {
    const known = new Set(ids);
    const tasks = [{ instance_id: ids[7]! }, { instance_id: ids[2]! }, { instance_id: ids[19]! }];
    const cited = citedInstances(tasks, known);
    assert.deepEqual(cited, [ids[7]!, ids[2]!, ids[19]!].toSorted(), "every named id, in sorted order");
    assert.deepEqual(citedInstances(tasks, known), cited, "no seed, so no run-to-run drift");
});

test("[§swebench-corpus] a citation the split cannot satisfy is refused, never silently shortened", () => {
    const known = new Set(ids);
    assert.throws(
        () => citedInstances([{ instance_id: ids[0]! }, { instance_id: "django__django-99999" }], known),
        /cited instances absent from the dataset: django__django-99999/u,
        "a stale citation must not run as 1 of 2",
    );
    assert.throws(
        () => citedInstances([{ instance_id: ids[0]! }, { instance_id: ids[0]! }], known),
        /cited corpus repeats r0__x-0/u,
        "a repeated id would silently shrink the corpus",
    );
});
