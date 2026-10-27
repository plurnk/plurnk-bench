import test, { type TestContext } from "node:test";
import { Digest } from "@plurnk/plurnk-digest";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultBenchmarksDir, digestHasTurns, runLabels, digestHasModelTurns, publishRun, publishedRecord, foldRequiemAccounting } from "./publish.ts";
import type { BenchRecord } from "./record.ts";
import { allocateRunDirectory } from "./run-directory.ts";
import { benchmarksHome, jobsRoot, loadBenchmarkEnvironment, operatorConfigPath, selectedModel } from "./host-paths.ts";
import { parseEnv } from "node:util";

// ─── publish.test.ts ───
{
// A WAL-mode database whose committed rows still sit in its -wal file: the shape a trial's
// daemon leaves behind, and the one a filesystem copy loses.
const walDatabase = (path: string, rows: number): DatabaseSync => {
    const database = new DatabaseSync(path);
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence(n INTEGER)");
    for (let n = 0; n < rows; n += 1) database.exec(`INSERT INTO evidence VALUES (${n})`);
    return database;
};

const mockDigest = (t: TestContext, digestJson: unknown): void => {
    t.mock.method(Digest, "run", ({ digestDir }: { digestDir: string }) => {
        mkdirSync(digestDir);
        writeFileSync(join(digestDir, "digest.json"), JSON.stringify(digestJson));
    });
};

test("{§publish} the published plurnk.db is SQLite's consistent copy: committed WAL pages arrive, the source is untouched", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bench-pub-snapshot-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = join(root, "agent", "plurnk.db");
    mkdirSync(join(root, "agent"));
    const source = walDatabase(dbPath, 5);
    t.after(() => source.close());
    assert.ok(statSync(`${dbPath}-wal`).size > 0, "the fixture's rows are in the WAL, not the main file");
    const accounting = { requests: [], usage: null, costUsd: "0" };
    mockDigest(t, { turns: [{ producer: "model" }], workspaces: [{ accounting }], provider_requests: [], turn_attempts: [] });
    const record: BenchRecord = {
        harness: "deepswe", taskId: "fixture", model: "fixture", durationMs: 1,
        status: 200, outcome: "fail", reward: 0, turns: 1,
        run: { dbPath, workspaceId: 1 },
    };
    const output = publishRun(record, join(root, "runs"));
    assert.notEqual(output, null);
    const copy = new DatabaseSync(join(output!, "plurnk.db"), { readOnly: true });
    t.after(() => copy.close());
    const rows = (database: DatabaseSync): unknown => (database.prepare("SELECT count(*) AS n FROM evidence").get() as { n: number }).n;
    assert.equal(rows(copy), 5, "every committed row, including the WAL-resident ones");
    assert.ok(!readdirSync(output!).some((name) => name.endsWith("-wal") || name.endsWith(".zip")), "a plain folder: consolidated database, no sidecars, no archive");
    assert.equal(rows(source), 5, "the trial's database is read, never moved");
    assert.throws(() => publishRun({ ...record, run: { dbPath: join(root, "missing.db") } }, join(root, "runs")), {
        name: "Error", message: `no database at ${join(root, "missing.db")}`,
    });
});

test("{§publish} a folder allocated at launch is finalized in place: the database consolidated, digest and record beside it, nothing copied", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bench-pub-launch-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const runDir = allocateRunDirectory(join(root, "runs"), ["swebench", "fixture", "fixture"]);
    const dbPath = join(runDir, "plurnk.db");
    const source = walDatabase(dbPath, 5);
    source.close();
    const accounting = { requests: [], usage: null, costUsd: "0" };
    mockDigest(t, { turns: [{ producer: "model" }], workspaces: [{ accounting }], provider_requests: [], turn_attempts: [] });
    const record: BenchRecord = {
        harness: "swebench", taskId: "fixture", model: "fixture", durationMs: 1,
        status: 200, outcome: "fail", reward: 0, turns: 1,
        run: { dbPath, workspaceId: 1 },
    };
    const output = publishRun(record, join(root, "runs"), { runDir });
    assert.equal(output, runDir, "the folder opened at launch is the published one");
    assert.deepEqual(readdirSync(join(root, "runs")), [runDir.split("/").at(-1)], "no second folder is allocated");
    const copy = new DatabaseSync(dbPath, { readOnly: true });
    t.after(() => copy.close());
    assert.equal((copy.prepare("SELECT count(*) AS n FROM evidence").get() as { n: number }).n, 5, "every committed row survives consolidation");
    assert.ok(!readdirSync(runDir).some((name) => name.endsWith("-wal") || name.endsWith("-shm") || name.endsWith(".consolidated")), "a plain folder: no sidecars, no leftovers");
    assert.ok(existsSync(join(runDir, "record.json")) && existsSync(join(runDir, "digest")), "record and digest sit beside the database");
});

test("{§publish} publication includes child requests and preserves the primary context", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bench-pub-accounting-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = join(root, "source.db");
    walDatabase(dbPath, 1).close();
    const parent = { model: "parent", usage: { inputTokens: 100 }, cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" } };
    const child = { model: "child", usage: { inputTokens: 50 }, cost: { kind: "charged", amount: { amount: "0.02", currency: "USD" }, source: "fixture" } };
    const accounting = {
        requests: [parent, child],
        usage: { inputTokens: 150, outputTokens: 30, inputTokenDetails: { cacheReadTokens: 80 } },
        costUsd: "0.03",
    };
    t.mock.method(Digest, "run", ({ digestDir }: { digestDir: string }) => {
        mkdirSync(digestDir);
        writeFileSync(join(digestDir, "digest.json"), JSON.stringify({
            turns: [{ producer: "model" }],
            workspaces: [{ accounting }],
            provider_requests: accounting.requests.map((request) => ({ kind: "emission", accounting: request })),
            turn_attempts: [{ accepted: true }],
        }));
    });
    const record: BenchRecord = {
        harness: "deepswe", taskId: "fixture", model: "fixture", durationMs: 1,
        status: 200, outcome: "fail", reward: 0, turns: 1,
        run: { dbPath, workspaceId: 1, workerId: 4 },
        usage: {
            accounting: { requests: [parent], usage: { inputTokens: 100 }, costUsd: "0.01" },
            curationWeight: 20, curationBudget: 40, contextTokens: 30, contextCapacity: 60, meta: {},
        },
    };
    const output = publishRun(record, join(root, "runs"));
    assert.notEqual(output, null);
    const published = JSON.parse(readFileSync(join(output!, "record.json"), "utf8")) as BenchRecord;
    assert.deepEqual(published.usage?.accounting, accounting);
    assert.equal(published.usage?.contextTokens, 30);
    assert.equal(published.reward, 0);
    assert.equal(record.usage?.accounting?.requests.length, 1, "publication does not rewrite client evidence");
});

// run<N> auto-increments off the highest existing run, ignoring non-run dirs.
test("{§publish} a published run is named run<N>-<harness>-<task>-<model>, N continuing the tree", () => {
    const labels = runLabels({ harness: "enterprise", taskId: "Enterprise-Bench/eng-l1-a", model: "plurnk/deepdumb" } as BenchRecord);
    assert.deepEqual(labels, ["enterprise", "eng-l1-a", "deepdumb"]);
    const root = mkdtempSync(join(tmpdir(), "bench-pub-"));
    try {
        mkdirSync(join(root, "run21-deepswe-abs-module-cache-flags-deepdumb"));
        const dir = allocateRunDirectory(root, labels);
        assert.equal(dir, join(root, "run22-enterprise-eng-l1-a-deepdumb"));
        assert.deepEqual(readdirSync(root).toSorted(), ["run21-deepswe-abs-module-cache-flags-deepdumb", "run22-enterprise-eng-l1-a-deepdumb"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("{§publish} publishRun returns null when the record has no run handle", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "t", model: "m",
        durationMs: 0, status: 0, outcome: "error", turns: 0,
    };
    assert.equal(publishRun(record, mkdtempSync(join(tmpdir(), "bench-pub-"))), null);
});

test("{§publish} the DB's own model turn defines a benchmark attempt", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-digest-"));
    try {
        assert.equal(digestHasModelTurns(dir), false);                                                           // no digest.json
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [{ producer: "_plurnk", kind: "initialization" }] }));
        assert.equal(digestHasModelTurns(dir), false);                                                           // setup only
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [{ producer: "_plurnk" }, { producer: "model", kind: "inference" }] }));
        assert.equal(digestHasModelTurns(dir), true);                                                            // a client record that died mid-loop still counts
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("{§publish} digestHasTurns is false for an absent or empty digest, true with turns", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-dig-"));
    try {
        assert.equal(digestHasTurns(dir), false);                                   // no digest.json
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [] }));
        assert.equal(digestHasTurns(dir), false);                                   // empty loop
        writeFileSync(join(dir, "digest.json"), JSON.stringify({ turns: [{ sequence: 1 }] }));
        assert.equal(digestHasTurns(dir), true);                                    // real loop
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

// record.json makes benchmarks/run<N> self-sufficient: it re-points the digest handle at the
// published DB and carries the oracle side (reward/outcome/filesModified) the DB+digest lack.
test("{§publish} publishedRecord re-points the DB handle and preserves the oracle fields", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "abs-module-cache-flags", model: "plurnk/gbuild",
        durationMs: 1000, status: 499, outcome: "timeout", turns: 15,
        reward: 0, filesModified: 1, p2pRegressed: true, testPassFraction: 0.13,
        run: { dbPath: "/jobs/scratch/agent/plurnk.db", workerId: 7, workspaceId: 1, loopId: 8 },
    };
    const published = publishedRecord(record, "/benchmarks/run9/plurnk.db", {
        workspaces: [{ accounting: { requests: [], usage: null, costUsd: "0" } }],
        provider_requests: [], turn_attempts: [],
    });
    assert.equal(published.run!.dbPath, "/benchmarks/run9/plurnk.db");   // self-referential, not jobs/
    assert.equal(published.run!.workerId, 7);                             // handle otherwise intact
    // the oracle side that forced reads back to jobs/ now travels with the published record
    assert.equal(published.reward, 0);
    assert.equal(published.outcome, "timeout");
    assert.equal(published.filesModified, 1);
    assert.equal(published.p2pRegressed, true);
    assert.equal(record.run!.dbPath, "/jobs/scratch/agent/plurnk.db");   // input not mutated
});

test("{§publish} interrupted requests remain unknown rather than parent-only or zero", () => {
    const record: BenchRecord = {
        harness: "deepswe", taskId: "interrupted", model: "fixture", durationMs: 1,
        status: 499, outcome: "cancelled", turns: 1,
    };
    const digest = {
        workspaces: [{ accounting: null }],
        provider_requests: [{ kind: "emission", accounting: null }],
        turn_attempts: [{ accepted: null }],
    };
    const published = publishedRecord(record, "/bench/run/plurnk.db", digest);
    assert.equal(published.usage?.accounting, null);
    assert.equal(published.usage?.contextTokens, null);
    assert.equal(published.outcome, "cancelled");
    assert.throws(() => publishedRecord(record, "/bench/run/plurnk.db", {
        ...digest, workspaces: [...digest.workspaces, ...digest.workspaces],
    }), /exactly one workspace/);
    assert.throws(() => publishedRecord(record, "/bench/run/plurnk.db", {
        ...digest, workspaces: [{ accounting: { requests: [], usage: null, costUsd: "0" } }],
    }), /request count does not match/);
});

// The shared tree is a sibling of the bench repo.
test("{§publish} the one benchmarks home is ~/benchmarks unless PLURNK_BENCH_HOME says otherwise", () => {
    assert.equal(benchmarksHome({}, "/home/ada"), "/home/ada/benchmarks");
    assert.equal(benchmarksHome({ PLURNK_BENCH_HOME: "~/runs" }, "/home/ada"), "/home/ada/runs");
    assert.equal(benchmarksHome({ PLURNK_BENCH_HOME: "/srv/bench" }, "/home/ada"), "/srv/bench");
    assert.equal(benchmarksHome({ PLURNK_BENCH_HOME: "  " }, "/home/ada"), "/home/ada/benchmarks");
    assert.match(defaultBenchmarksDir(), /\/benchmarks$/);
    assert.doesNotMatch(defaultBenchmarksDir(), /plurnk-bench\/benchmarks$|\/ptl\/benchmarks$/);
});

test("{§publish} the requiem is banked only on PLURNK_BENCH_REQUIEM=1", () => {
    const source = readFileSync(new URL("./publish.ts", import.meta.url), "utf8");
    assert.match(source, /if \(process\.env\.PLURNK_BENCH_REQUIEM === "1"\) \{\s*try \{[\s\S]*?manifest\.bin\["plurnk-service"\]\), "requiem",/);
    assert.equal((source.match(/"requiem", join\(dir/g) ?? []).length, 1);
    assert.doesNotMatch(source, /loadActiveProvider|Digest\.requiem\(/, "the service CLI owns witness selection and configuration");
});

test("{§publish} a banked interview's spend folds into record.json under requiem", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-requiem-fold-"));
    try {
        writeFileSync(join(dir, "record.json"), JSON.stringify({
            harness: "deepswe",
            taskId: "fixture-task",
            model: "plurnk/fixture",
            durationMs: 1,
            status: 200,
            outcome: "pass",
            turns: 1,
        }, null, 4) + "\n");
        mkdirSync(join(dir, "digest"));
        writeFileSync(join(dir, "digest", "requiem.json"), JSON.stringify({
            workers: [{
                accounting: {
                    requests: [{
                        provider: "provider:fixture",
                        model: "requiem-witness",
                        outcome: "response",
                        usage: { inputTokens: 10, inputTokenDetails: { cacheReadTokens: 1 } },
                        cost: { kind: "charged", amount: { amount: "0.05", currency: "USD" }, source: "fixture" },
                    }],
                    usage: {
                        inputTokens: 10,
                        outputTokens: 2,
                        totalTokens: 12,
                        inputTokenDetails: { cacheReadTokens: 1 },
                        outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
                    },
                    costUsd: "0.05",
                },
            }],
        }));
        foldRequiemAccounting(dir);
        const record = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as BenchRecord;
        assert.equal(record.taskId, "fixture-task", "the original record survives the fold");
        assert.deepEqual(record.requiem, {
            workers: 1,
            providerRequests: 1,
            usage: {
                inputTokens: 10,
                outputTokens: 2,
                totalTokens: 12,
                inputTokenDetails: { cacheReadTokens: 1 },
                outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
            },
            cacheEffectiveness: { inputTokens: 10, cacheReadTokens: 1, cacheReadTokenRatio: 0.1 },
            costUsd: "0.05",
            knownCostUsd: "0.05",
            pricedRequests: 1,
            costEvidence: { charged: 1, estimated: 0, unknown: 0 },
        });
        // A missing requiem report fails hard - never a silent no-op.
        rmSync(join(dir, "digest", "requiem.json"));
        assert.throws(() => foldRequiemAccounting(dir), /ENOENT/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("{§publish} the published digest is workspace-scoped, never worker-narrowed", () => {
    const source = readFileSync(new URL("./publish.ts", import.meta.url), "utf8");
    const call = source.match(/Digest\.run\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    assert.match(call, /workspaceId/);
    assert.doesNotMatch(call, /workerId/, "worker narrowing excludes child worker evidence");
});

test("{§publish} a trial's own digest is published verbatim; the installed service renders nothing", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bench-pub-provenance-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const dbPath = join(root, "agent", "plurnk.db");
    mkdirSync(join(root, "agent", "digest"), { recursive: true });
    const source = walDatabase(dbPath, 1);
    t.after(() => source.close());
    const accounting = { requests: [], usage: null, costUsd: "0" };
    const own = { turns: [{ producer: "model" }], workspaces: [{ accounting }], workers: [{ id: 1, edit_census: { edits: 3, refused: 0, revisits: 1, forms: { hash: 3 } } }], provider_requests: [], turn_attempts: [] };
    writeFileSync(join(root, "agent", "digest", "digest.json"), JSON.stringify(own));
    writeFileSync(join(root, "agent", "digest", "digest.md"), "# rendered by the candidate's runtime\n");
    const rendered = t.mock.method(Digest, "run", () => { throw new Error("the installed service must not render a digest the candidate already rendered"); });
    const record: BenchRecord = {
        harness: "deepswe", taskId: "fixture", model: "fixture", durationMs: 1,
        status: 200, outcome: "fail", reward: 0, turns: 1,
        run: { dbPath, workspaceId: 1, digestDir: join(root, "agent", "digest") },
    };
    const output = publishRun(record, join(root, "runs"));
    assert.notEqual(output, null);
    assert.equal(rendered.mock.callCount(), 0);
    assert.deepEqual(JSON.parse(readFileSync(join(output!, "digest", "digest.json"), "utf8")), own, "the census the candidate's runtime wrote survives publication");
    assert.equal(readFileSync(join(output!, "digest", "digest.md"), "utf8"), "# rendered by the candidate's runtime\n");
});
}

// ─── host-paths.test.ts ───
{
test("{§config-carry} operatorConfigPath follows XDG while preserving an explicit bench override", () => {
    assert.equal(operatorConfigPath(undefined, {}, "/home/ada"), "/home/ada/.config/plurnk/.env");
    assert.equal(
        operatorConfigPath(undefined, { XDG_CONFIG_HOME: "/cfg" }, "/home/ada"),
        "/cfg/plurnk/.env",
    );
    assert.equal(
        operatorConfigPath(undefined, { XDG_CONFIG_HOME: "relative" }, "/home/ada"),
        "/home/ada/.config/plurnk/.env",
    );
    assert.equal(operatorConfigPath("~/operator.env", {}, "/home/ada"), "/home/ada/operator.env");
    assert.equal(operatorConfigPath("/run/operator.env", {}, "/home/ada"), "/run/operator.env");
});

test("{§publish} jobsRoot keeps every harness's job scratch under the benchmarks home", () => {
    assert.equal(benchmarksHome({}, "/home/ada"), "/home/ada/benchmarks");
    assert.equal(jobsRoot("enterprise", {}, "/home/ada"), "/home/ada/benchmarks/jobs/enterprise");
    assert.equal(jobsRoot("deepswe", { PLURNK_BENCH_HOME: "/srv/bench" }, "/home/ada"), "/srv/bench/jobs/deepswe");
});

test("{§config-carry} benchmark environment loads operator config before committed defaults", (t) => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-bench-env-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const operator = resolve(root, "operator.env");
    const defaults = resolve(root, "defaults.env");
    writeFileSync(operator, "PLURNK_MODEL=operator\n");
    writeFileSync(defaults, "PLURNK_MODEL=default\n");
    const loadInto = (env: NodeJS.ProcessEnv, loaded: string[]) => (path: string) => {
        loaded.push(path);
        for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
            if (env[key] === undefined) env[key] = value;
        }
    };
    const operatorSelected: NodeJS.ProcessEnv = {};
    const operatorLoaded: string[] = [];

    const resolved = loadBenchmarkEnvironment(
        operator,
        defaults,
        operatorSelected,
        loadInto(operatorSelected, operatorLoaded),
    );

    assert.equal(resolved, operator);
    assert.deepEqual(operatorLoaded, [operator, defaults]);
    assert.equal(selectedModel(operatorSelected), "operator", "XDG operator config wins over defaults");

    const shellSelected: NodeJS.ProcessEnv = { PLURNK_MODEL: "shell" };
    loadBenchmarkEnvironment(operator, defaults, shellSelected, loadInto(shellSelected, []));
    assert.equal(selectedModel(shellSelected), "shell", "the invoking shell wins over both files");

    const defaultSelected: NodeJS.ProcessEnv = {};
    loadBenchmarkEnvironment(resolve(root, "absent.env"), defaults, defaultSelected, loadInto(defaultSelected, []));
    assert.equal(selectedModel(defaultSelected), "default", "the committed floor fills an unset selection");
});

test("{§config-carry} the candidate selection is the ordinary PLURNK_MODEL", () => {
    assert.equal(selectedModel({ PLURNK_MODEL: "deepdumb" }), "deepdumb");
    assert.equal(selectedModel({ PLURNK_MODEL: " cloudflare-workers-ai/@cf/qwen/qwen3.8-27b " }), "cloudflare-workers-ai/@cf/qwen/qwen3.8-27b");
    assert.throws(() => selectedModel({}), /PLURNK_MODEL/);
    assert.throws(() => selectedModel({ PLURNK_MODEL: " " }), /PLURNK_MODEL/);
});

test("{§config-carry} the committed bench floor disables question through executor policy", () => {
    const defaults = parseEnv(readFileSync(new URL("../.env.defaults", import.meta.url), "utf8"));
    assert.equal(defaults.PLURNK_EXECS_QUESTION, "0");
    assert.equal(defaults.PLURNK_SERVICE_PROVIDER_RECOVERY, undefined, "benchmarks inherit product recovery unless the operator overrides it");
});
}

// ─── run-directory.test.ts ───
{
test("{§publish} numbered forensic runs share one flat, collision-safe namespace", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-bench-runs-"));
    try {
        mkdirSync(resolve(root, "run4-existing"));
        assert.equal(
            basename(allocateRunDirectory(root, ["atlas", "filesystem read", "grok"])),
            "run5-atlas-filesystem-read-grok",
        );
        assert.equal(
            basename(allocateRunDirectory(root, ["deepswe", "abs", "glm"])),
            "run6-deepswe-abs-glm",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
}
