// SPEC §swebench-corpus. Draw the campaign's task sample from the official Lite dataset
// reproducibly: a seed plus a plain hash order, never an RNG whose stream can drift between
// library versions. The draw is a CORPUS record — ids, dataset identity, algorithm, seed — so a
// later run is reproducible or restrictable to exactly the same tasks. A seeded draw is OUR
// sample — a declared shape, not parity. Parity needs the study to name its own ids, which
// --cited takes verbatim and verifies against the split.
//
// usage: node swebench/sample.ts --label <name> [--seed <s>] [--count 30]
//          [--mode uniform|stratified] [--cited <file>] [--out swebench/corpora/<label>.json] [--pin]

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DATASET = "SWE-bench/SWE-bench_Lite";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");
const python = process.env.PLURNK_SWEBENCH_PYTHON ?? resolve(benchRoot, ".cache/swebench/venv/bin/python");

// "cited" is not a draw: a published study names its own ids, so the corpus records WHERE they
// came from instead of how they were picked. Parity with such a study is impossible under any
// seed — {§swebench-corpus}.
export type SampleMode = "uniform" | "stratified" | "cited";

export interface CorpusCitation {
    readonly study: string;
    readonly url: string;
    readonly repository: string;
    readonly commit: string;
    readonly cohort: string;
    readonly datasetRevision: string;
    readonly attemptsPerTask: number;
    readonly turnCap: number;
    readonly brief: string;
}

export interface CorpusRecord {
    readonly schemaVersion: 1;
    readonly harness: "swebench";
    readonly dataset: string;
    readonly label: string;
    readonly mode: SampleMode;
    readonly seed?: string;
    readonly source?: CorpusCitation;
    readonly count: number;
    readonly instances: readonly string[];
    readonly repos: Readonly<Record<string, number>>;
}

// The draw order is a deterministic function of (seed, instance id) alone — no RNG, no reliance
// on the dataset's own row order.
const rankKey = (seed: string, instance: string): string =>
    createHash("sha256").update(`${seed}|${instance}`).digest("hex");

export const rankBySeed = (instances: readonly string[], seed: string): string[] =>
    [...instances].sort((left, right) => {
        const byHash = rankKey(seed, left).localeCompare(rankKey(seed, right));
        return byHash !== 0 ? byHash : left.localeCompare(right);
    });

export const uniformDraw = (instances: readonly string[], seed: string, count: number): string[] =>
    rankBySeed(instances, seed).slice(0, count).toSorted();

// Round-robin across repos in a stable repo order, each repo's own members hash-ranked, so a
// 30-draw spreads across the dataset's 12 repos instead of letting django+sympy (191 of 300)
// dominate. Coverage, not parity — declared as such.
export const stratifiedDraw = (
    instances: readonly string[],
    repoOf: (instance: string) => string,
    seed: string,
    count: number,
): string[] => {
    const buckets = new Map<string, string[]>();
    for (const instance of rankBySeed(instances, seed)) {
        const repo = repoOf(instance);
        const bucket = buckets.get(repo) ?? [];
        bucket.push(instance);
        buckets.set(repo, bucket);
    }
    const repos = [...buckets.keys()].toSorted();
    const drawn: string[] = [];
    for (let index = 0; drawn.length < count; index += 1) {
        let progressed = false;
        for (const repo of repos) {
            const bucket = buckets.get(repo)!;
            if (index < bucket.length && drawn.length < count) {
                drawn.push(bucket[index]!);
                progressed = true;
            }
        }
        if (!progressed) break;
    }
    return drawn.toSorted();
};

// A cited corpus is VERIFIED against the dataset, never drawn from it: an id the split does not
// carry means the citation is stale, and parity is then a claim we cannot make. Refuse loudly
// rather than quietly run a corpus that is 29 of the study's 30.
export const citedInstances = (
    tasks: ReadonlyArray<{ readonly instance_id: string }>,
    known: ReadonlySet<string>,
): string[] => {
    const ids = tasks.map(({ instance_id }) => instance_id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) throw new Error(`cited corpus repeats ${[...new Set(duplicates)].join(", ")}`);
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length > 0) throw new Error(`cited instances absent from the dataset: ${missing.join(", ")}`);
    return ids.toSorted();
};

export const repoCounts = (instances: readonly string[], repoOf: (instance: string) => string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const instance of instances) {
        const repo = repoOf(instance);
        counts[repo] = (counts[repo] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).toSorted(([left], [right]) => left.localeCompare(right)));
};

const loadCorpus = (): Array<{ instance_id: string; repo: string }> => {
    const dump = `
import json
from datasets import load_dataset
ds = load_dataset(${JSON.stringify(DATASET)}, split="test")
print(json.dumps([{"instance_id": r["instance_id"], "repo": r["repo"]} for r in ds]))
`;
    const out = spawnSync(python, ["-c", dump], {
        encoding: "utf8",
        env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1" },
    });
    if (out.error !== undefined) throw out.error;
    if (out.status !== 0) throw new Error(`dataset load failed: ${out.stderr.trim()}`);
    return JSON.parse(out.stdout) as Array<{ instance_id: string; repo: string }>;
};

const main = (): void => {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            label: { type: "string" },
            seed: { type: "string" },
            count: { type: "string" },
            mode: { type: "string" },
            out: { type: "string" },
            cited: { type: "string" },
            pin: { type: "boolean", default: false },
        },
        allowPositionals: false,
        strict: true,
    });
    const label = values.label;
    if (label === undefined || label.trim() === "") {
        throw new Error("usage: node swebench/sample.ts --label <name> [--seed <s>] [--count 30] [--mode uniform|stratified] [--out <file>] [--pin]");
    }
    const seed = values.seed ?? label;
    const count = values.count === undefined ? 30 : Number(values.count);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("--count must be a positive integer");
    const mode = (values.cited !== undefined ? "cited" : values.mode ?? "uniform") as SampleMode;
    if (mode !== "uniform" && mode !== "stratified" && mode !== "cited") {
        throw new Error("--mode must be uniform, stratified or cited");
    }
    if (mode === "cited" && values.cited === undefined) throw new Error("--mode cited requires --cited <file>");

    const rows = loadCorpus();
    const ids = rows.map((row) => row.instance_id);
    const repo = new Map(rows.map((row) => [row.instance_id, row.repo] as const));
    const repoOf = (instance: string): string => repo.get(instance) ?? "unknown";
    if (count > ids.length) throw new Error(`--count ${count} exceeds the ${ids.length} dataset instances`);

    // A cited corpus is verified against the dataset rather than drawn from it: every named id
    // must exist in the split, or the citation is stale and parity is a claim we cannot make.
    const cited = values.cited === undefined
        ? null
        : JSON.parse(readFileSync(resolve(benchRoot, values.cited), "utf8")) as {
            cited: CorpusCitation;
            tasks: ReadonlyArray<{ instance_id: string }>;
        };
    const instances = cited !== null
        ? citedInstances(cited.tasks, new Set(ids))
        : mode === "uniform" ? uniformDraw(ids, seed, count) : stratifiedDraw(ids, repoOf, seed, count);
    const record: CorpusRecord = {
        schemaVersion: 1,
        harness: "swebench",
        dataset: DATASET,
        label,
        mode,
        ...(cited === null ? { seed } : { source: cited.cited }),
        count: instances.length,
        instances,
        repos: repoCounts(instances, repoOf),
    };
    const out = resolve(benchRoot, values.out ?? join("swebench", "corpora", `${label}.json`));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`wrote ${out} (${instances.length} ${mode}, ${cited === null ? `seed ${JSON.stringify(seed)}` : `cited ${cited.cited.commit.slice(0, 12)}`})`);
    console.log(JSON.stringify(record.repos, null, 2));

    if (values.pin === true) {
        const pinned = spawnSync(process.execPath, [join(moduleDir, "pin-task.mjs"), ...instances], {
            cwd: benchRoot,
            stdio: "inherit",
            env: process.env,
        });
        if (pinned.error !== undefined) throw pinned.error;
        if (pinned.status !== 0) throw new Error(`pin-task exited ${pinned.status ?? pinned.signal ?? "unknown"}`);
    }
};

if (import.meta.main) main();
