// Publish a bench run to a shared, human-referenceable tree so service can inspect it by
// name: <plurnk>/benchmarks/run<N>/{plurnk.db, digest/}. Copies the run's DB and renders
// its digest there (reusing the daemon's Digest — bench builds no forensics). N
// auto-increments. "check out run<N> with me" is the whole point: a stable handle outside
// the gitignored jobs/ scratch.

import { readdirSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Digest from "@plurnk/plurnk-service/digest";
import { readJob } from "./ingest.ts";
import type { BenchRecord } from "./record.ts";

// Sibling of the bench repo: <plurnk>/benchmarks (plurnk-bench/src/.. /.. /benchmarks).
export const defaultBenchmarksDir = (): string =>
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "benchmarks");

// Next free run<N> in the tree — max existing + 1, else 1.
export const nextRunNumber = (benchmarksDir: string): number => {
    if (!existsSync(benchmarksDir)) return 1;
    const ns = readdirSync(benchmarksDir)
        .map((name) => /^run(\d+)$/.exec(name))
        .filter((m) => m !== null)
        .map((m) => Number(m![1]));
    return ns.length > 0 ? Math.max(...ns) + 1 : 1;
};

// Copy the run's DB + render its digest into benchmarks/run<N>/. The digest reads the
// COPIED DB, so the run dir is self-contained. No run handle → nothing to publish (null).
export const publishRun = (record: BenchRecord, benchmarksDir: string): string | null => {
    if (record.run === undefined) return null;
    const runDir = join(benchmarksDir, `run${nextRunNumber(benchmarksDir)}`);
    mkdirSync(runDir, { recursive: true });
    const db = join(runDir, "plurnk.db");
    copyFileSync(record.run.dbPath, db);
    Digest.run({
        dbPath: db,
        digestDir: join(runDir, "digest"),
        ...(record.run.runId !== undefined ? { runId: record.run.runId } : {}),
        ...(record.run.sessionId !== undefined ? { sessionId: record.run.sessionId } : {}),
    });
    return runDir;
};

if (import.meta.main) {
    const [jobDir, benchmarksDir = defaultBenchmarksDir()] = process.argv.slice(2);
    if (jobDir === undefined) {
        process.stderr.write("usage: node src/publish.ts <jobDir> [benchmarksDir]\n");
        process.exit(1);
    }
    for (const record of readJob(jobDir, { harness: "deepswe" })) {
        const dir = publishRun(record, benchmarksDir);
        console.log(dir ? `published ${record.taskId} (${record.outcome}) → ${dir}` : `skipped ${record.taskId} (no run DB)`);
    }
}
