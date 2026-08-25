// SPEC §publish / §results-canon. Publish a bench run to the one shared, human-referenceable
// tree so anyone can inspect it by name: <home>/run<N>-<harness>-<task>-<model>/{plurnk.db,
// digest/, record.json}. Copies the run's DB, renders its digest (reusing the daemon's Digest
// — bench builds no forensics), and writes the joined BenchRecord (the oracle side:
// reward/outcome, which the DB+digest do NOT carry) so the run dir is a COMPLETE,
// self-sufficient results source — read it here, never the jobs/ scratch.
//
// Trials publish the moment they finish (`--watch`), so a corpus can be followed run by run
// while it is still going. A trial that already published is never republished: its
// marker names the run dir.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import Digest from "@plurnk/plurnk-service/digest";
import { isTrialDir, readTrialDir } from "./ingest.ts";
import { benchmarksHome, jobsRoot } from "./host-paths.ts";
import { allocateRunDirectory } from "./run-directory.ts";
import type { BenchRecord } from "./record.ts";

export const PUBLISHED_MARKER = ".plurnk-bench-published";
const WATCH_INTERVAL_MS = 15_000;

export const defaultBenchmarksDir = (): string => benchmarksHome();

// SPEC §publish-numbering. run<N>-<harness>-<task>-<model>: the task's last path segment
// and the model's alias, so the tree reads like the benchlets' own.
export const runLabels = (record: BenchRecord): string[] => [
    record.harness,
    record.taskId.split("/").at(-1) ?? record.taskId,
    record.model.replace(/^plurnk\//, ""),
];

const digestTurns = (digestDir: string): Array<{ producer?: string }> => {
    try {
        const { turns } = JSON.parse(readFileSync(join(digestDir, "digest.json"), "utf8"));
        return Array.isArray(turns) ? turns : [];
    } catch {
        return [];
    }
};

// SPEC §publish-turnless-gate. A published run must hold a real loop. An infra failure (daemon never looped) copies a
// turn-less DB; the digest (bench's own artifact) confirms 0 turns → not worth the tree.
export const digestHasTurns = (digestDir: string): boolean => digestTurns(digestDir).length > 0;

// SPEC §publish-model-attempt-gate. The DB's own evidence decides: at least one model turn.
// Setup/maintenance turns alone are no attempt; a trial whose client record died mid-loop
// still publishes, because its model turns are in the DB.
export const digestHasModelTurns = (digestDir: string): boolean =>
    digestTurns(digestDir).some((turn) => turn.producer === "model");

// SPEC §publish-self-referential. The record persisted into the run dir: the joined record with its
// digest handle re-pointed at the published (copied) DB, so it never references jobs/ scratch.
export const publishedRecord = (record: BenchRecord, dbPath: string): BenchRecord => ({
    ...record,
    run: { ...record.run, dbPath },
});

// Copy the run's DB + render its digest into the allocated run dir. The digest reads the
// COPIED DB, so the run dir is self-contained. No run handle → nothing to publish (null).
// A run without a model turn is rolled back rather than published.
export const publishRun = (record: BenchRecord, benchmarksDir: string): string | null => {
    if (record.run === undefined) return null;
    const runDir = allocateRunDirectory(benchmarksDir, runLabels(record));
    const digestDir = join(runDir, "digest");
    const db = join(runDir, "plurnk.db");
    copyFileSync(record.run.dbPath, db);
    Digest.run({
        dbPath: db,
        digestDir,
        ...(record.run.workerId !== undefined ? { workerId: record.run.workerId } : {}),
        ...(record.run.workspaceId !== undefined ? { workspaceId: record.run.workspaceId } : {}),
    });
    if (!digestHasModelTurns(digestDir)) {
        rmSync(runDir, { recursive: true, force: true });
        return null;
    }
    // Persist the joined record (self-referential to the copied DB) so the run dir
    // answers pass/fail without the jobs/ tree.
    writeFileSync(join(runDir, "record.json"), JSON.stringify(publishedRecord(record, db), null, 4) + "\n");
    return runDir;
};

// SPEC §publish-live. One finished trial → one published run, exactly once: the marker in
// the trial dir names the run dir (or is empty when the trial had nothing to publish).
export const publishTrial = async (trialDir: string, harness: string, benchmarksDir: string): Promise<string | null> => {
    const marker = join(trialDir, PUBLISHED_MARKER);
    if (existsSync(marker)) {
        const previous = readFileSync(marker, "utf8").trim();
        return previous === "" ? null : previous;
    }
    const record = readTrialDir(trialDir, { harness });
    if (record === null) return null;
    const dir = publishRun(record, benchmarksDir);
    if (dir === null) {
        writeFileSync(marker, "");
        console.log(`skipped ${record.taskId} (no model turn to publish)`);
        return null;
    }
    // SPEC §publish-requiem. The model's exit interview is an investigation instrument,
    // banked only on request (PLURNK_BENCH_REQUIEM=1): it re-invokes the model once per
    // published run. When requested it stays best-effort — a missing witness is a skip,
    // never a publish failure — the run is already published.
    let note = "";
    if (process.env.PLURNK_BENCH_REQUIEM === "1") {
        try {
            await Digest.requiem({ dbPath: join(dir, "plurnk.db"), digestDir: join(dir, "digest") });
            note = " + requiem";
        } catch (e) {
            note = ` (requiem skipped: ${(e as Error).message.slice(0, 70)})`;
        }
    }
    writeFileSync(marker, `${dir}\n`);
    console.log(`published ${record.taskId} (${record.outcome}) → ${dir}${note}`);
    return dir;
};

const trialDirs = (jobDir: string): string[] => readdirSync(jobDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(jobDir, entry.name))
    .filter(isTrialDir)
    .toSorted();

export const publishJob = async (jobDir: string, harness: string, benchmarksDir: string): Promise<void> => {
    for (const trialDir of trialDirs(jobDir)) await publishTrial(trialDir, harness, benchmarksDir);
};

const processAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

// SPEC §publish-live. Follow a running job: publish each trial as its result lands, until
// the harness process exits; one final sweep catches the trials that finished last.
export const watchJob = async (jobDir: string, pid: number, harness: string, benchmarksDir: string): Promise<void> => {
    while (processAlive(pid)) {
        await publishJob(jobDir, harness, benchmarksDir);
        await sleep(WATCH_INTERVAL_MS);
    }
    await publishJob(jobDir, harness, benchmarksDir);
};

if (import.meta.main) {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        allowPositionals: true,
        options: {
            home: { type: "boolean" },
            jobs: { type: "string" },
            watch: { type: "string" },
            pid: { type: "string" },
        },
    });
    if (values.home) {
        console.log(benchmarksHome());
    } else if (values.jobs !== undefined) {
        console.log(jobsRoot(values.jobs));
    } else {
        // SPEC §config-bench-namespace: the harness label is a bench knob, never daemon config.
        const harness = process.env.PLURNK_BENCH_HARNESS ?? "deepswe";
        const benchmarksDir = positionals[1] ?? defaultBenchmarksDir();
        if (values.watch !== undefined) {
            const pid = Number(values.pid);
            if (!Number.isInteger(pid) || pid <= 0) throw new Error("--watch requires --pid <harness process id>");
            await watchJob(values.watch, pid, harness, benchmarksDir);
        } else if (positionals[0] === undefined) {
            process.stderr.write("usage: node src/publish.ts <jobDir|trialDir> [benchmarksDir] | --watch <jobDir> --pid <n> | --home | --jobs <harness>\n");
            process.exit(1);
        } else if (isTrialDir(positionals[0])) {
            await publishTrial(positionals[0], harness, benchmarksDir);
        } else {
            await publishJob(positionals[0], harness, benchmarksDir);
        }
    }
}
