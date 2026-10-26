// {§tier-corpus} — Real-model `live` and `demo` specimen suites driven against a candidate
// service and client checkout, publishing session records (`record.json` + `digest/`) and a
// tier census + task report under the unified benchmark home.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { summarizeTasks, type TaskReport } from "../deepswe/report.ts";
import { summarizeDigestAccounting, type DigestAccountingInput } from "../src/accounting.ts";
import { readDigest } from "../src/digest.ts";
import { benchmarksHome, loadBenchmarkEnvironment, selectedModel } from "../src/host-paths.ts";
import { publishedRecord } from "../src/publish.ts";
import type { BenchRecord, Outcome } from "../src/record.ts";
import { sourceProvenance } from "../src/source-provenance.ts";
import { webMaterializationProvenance } from "../src/web-materialization.ts";

export type TierName = "live" | "demo";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");

const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

export const tierStamp = (at: Date = new Date()): string =>
    process.env.PLURNK_TIER_STAMP ?? at.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");

export const tierRunDir = (
    tier: TierName,
    home: string = benchmarksHome(),
    stamp: string = tierStamp(),
): string => join(home, `tier-${tier}-${stamp}`);

export const tierFiles = (tier: TierName, root: string = moduleDir): string[] => {
    const dir = join(root, tier);
    return readdirSync(dir)
        .filter((file) => file.endsWith(".test.ts"))
        .toSorted()
        .map((file) => join(dir, file));
};

export const selectTierSpecimens = (
    requested: readonly string[],
    known: readonly string[],
    label: string,
): readonly string[] => {
    const available = new Set(known);
    for (const name of requested) {
        if (!available.has(name)) {
            throw new Error(
                `unknown ${label} specimen: ${JSON.stringify(name)}\navailable ${label} specimens:\n  ${known.join("\n  ")}`,
            );
        }
    }
    return requested;
};

export interface TierInvocationOptions {
    readonly tier: TierName;
    readonly serviceRoot: string;
    readonly clientRoot: string;
    readonly runDir: string;
    readonly files: readonly string[];
    readonly names?: readonly string[];
    readonly loaderPath?: string;
    readonly reporterPath?: string;
}

export const buildTierInvocation = ({
    serviceRoot,
    clientRoot,
    runDir,
    files,
    names = [],
    loaderPath = resolve(moduleDir, "loader.ts"),
    reporterPath = resolve(serviceRoot, "plurnk-core/scripts/lib/census-reporter.mjs"),
}: TierInvocationOptions): {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
} => {
    const serviceCore = resolve(serviceRoot, "plurnk-core");
    const envFiles = [
        resolve(serviceCore, ".env.test"),
        resolve(serviceCore, ".env.defaults"),
    ].filter((file) => existsSync(file));
    return {
        command: process.execPath,
        args: [
            "--conditions=plurnk-dev",
            `--import=${pathToFileURL(loaderPath).href}`,
            ...envFiles.map((file) => `--env-file-if-exists=${file}`),
            "--test",
            "--test-concurrency=1",
            "--test-force-exit",
            "--test-reporter=spec",
            "--test-reporter-destination=stdout",
            `--test-reporter=${pathToFileURL(reporterPath).href}`,
            `--test-reporter-destination=${join(runDir, "census.md")}`,
            ...(names.length === 0 ? [] : [`--test-name-pattern=^(?:${names.map(escapePattern).join("|")})$`]),
            ...files,
        ],
        cwd: serviceCore,
        env: {
            PLURNK_TIERS_SERVICE_ROOT: serviceCore,
            PLURNK_SERVICE_CHECKOUT: serviceRoot,
            PLURNK_CLIENT_CHECKOUT: clientRoot,
            PLURNK_BENCHMARKS: runDir,
            PLURNK_TIER_RUN_DIR: runDir,
        },
    };
};

interface CensusVerdict {
    readonly name: string;
    readonly file: string | null;
    readonly status: "passed" | "failed" | "skipped" | "cancelled";
    readonly durationMs: number;
    readonly reason: string | null;
}

interface CensusSession {
    readonly specimen: string | null;
    readonly label: string;
    readonly runDir: string;
    readonly loops: number;
    readonly turns: number;
    readonly requests: number;
}

interface CensusDocument {
    readonly verdicts?: readonly CensusVerdict[];
    readonly sessions?: readonly CensusSession[];
}

const verdictOutcome = (status: CensusVerdict["status"]): { outcome: Outcome; reward?: 0 | 1 } => {
    switch (status) {
        case "passed":
            return { outcome: "pass", reward: 1 };
        case "failed":
            return { outcome: "fail", reward: 0 };
        case "cancelled":
            return { outcome: "cancelled", reward: 0 };
        case "skipped":
            return { outcome: "error" };
    }
};

// {§tier-corpus} — fold session digests into BenchRecord (`record.json`) and summarize the tier run
// under the shared `deepswe/report.ts` + `src/accounting.ts` contract.
export const publishTierSessions = ({
    tier,
    runDir,
    model,
    env = process.env,
}: {
    readonly tier: TierName;
    readonly runDir: string;
    readonly model: string;
    readonly env?: NodeJS.ProcessEnv;
}): {
    readonly records: BenchRecord[];
    readonly summary: ReturnType<typeof summarizeTasks>;
} => {
    const censusPath = join(runDir, "census.json");
    const census: CensusDocument = existsSync(censusPath)
        ? (JSON.parse(readFileSync(censusPath, "utf8")) as CensusDocument)
        : {};
    const verdicts = new Map((census.verdicts ?? []).map((verdict) => [verdict.name, verdict]));
    const sessionsBySpecimen = new Map<string, CensusSession[]>();
    for (const session of census.sessions ?? []) {
        if (session.specimen === null) continue;
        const list = sessionsBySpecimen.get(session.specimen) ?? [];
        list.push(session);
        sessionsBySpecimen.set(session.specimen, list);
    }

    const records: BenchRecord[] = [];
    const sessionAccounting = new Map<string, ReturnType<typeof summarizeDigestAccounting>>();
    const webMaterialization = webMaterializationProvenance(env);

    for (const entry of readdirSync(runDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sessionDir = join(runDir, entry.name);
        const sessionCensusPath = join(sessionDir, "census.json");
        const digestPath = join(sessionDir, "digest", "digest.json");
        const dbPath = join(sessionDir, "plurnk.db");
        if (!existsSync(sessionCensusPath) || !existsSync(digestPath) || !existsSync(dbPath)) continue;
        const sessionMeta = JSON.parse(readFileSync(sessionCensusPath, "utf8")) as CensusSession;
        const digest = readDigest<DigestAccountingInput & { loops?: Array<{ status?: number }>; turns?: unknown[] }>(digestPath);
        if (!Array.isArray(digest.workspaces) || digest.workspaces.length === 0) continue;
        const accounting = summarizeDigestAccounting(digest);
        sessionAccounting.set(sessionDir, accounting);

        const verdict = sessionMeta.specimen === null ? undefined : verdicts.get(sessionMeta.specimen);
        const { outcome, reward } = verdict === undefined ? { outcome: "pass" as const, reward: 1 as const } : verdictOutcome(verdict.status);
        const lastLoopStatus = digest.loops?.at(-1)?.status ?? (outcome === "pass" ? 200 : 500);
        const baseRecord: BenchRecord = {
            harness: `tier-${tier}`,
            taskId: sessionMeta.specimen ?? sessionMeta.label,
            model,
            durationMs: Math.round(verdict?.durationMs ?? 0),
            status: lastLoopStatus,
            outcome,
            ...(reward === undefined ? {} : { reward }),
            turns: Array.isArray(digest.turns) ? digest.turns.length : sessionMeta.turns,
            run: {
                dbPath,
                digestDir: join(sessionDir, "digest"),
            },
            webMaterialization,
        };
        const finalized = publishedRecord(baseRecord, dbPath, digest);
        writeFileSync(join(sessionDir, "record.json"), `${JSON.stringify(finalized, null, 4)}\n`);
        records.push(finalized);
    }

    const taskRows: TaskReport[] = [];
    const seenTasks = new Set<string>();
    for (const verdict of census.verdicts ?? []) {
        if (seenTasks.has(verdict.name)) continue;
        seenTasks.add(verdict.name);
        const sessions = sessionsBySpecimen.get(verdict.name) ?? [];
        const primarySession = sessions[0];
        const accounting = primarySession === undefined ? null : (sessionAccounting.get(primarySession.runDir) ?? null);
        const { outcome, reward } = verdictOutcome(verdict.status);
        taskRows.push({
            task: verdict.name,
            reward: reward ?? null,
            outcome,
            durationMs: verdict.durationMs > 0 ? Math.round(verdict.durationMs) : null,
            evidence: primarySession?.runDir ?? runDir,
            accounting,
            costEvidence: accounting?.costEvidence ?? null,
        });
    }

    const summary = summarizeTasks(taskRows);
    writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ schemaVersion: 1, tier, model, ...summary }, null, 2)}\n`);
    return { records, summary };
};

const collectNamesInSubprocess = (serviceRoot: string, files: readonly string[]): string[] => {
    const serviceCore = resolve(serviceRoot, "plurnk-core");
    const loaderPath = resolve(moduleDir, "loader.ts");
    const script = [
        `import { collectLiveTestNames } from "@plurnk/plurnk-service/harness";`,
        `const names = await collectLiveTestNames(${JSON.stringify(files)});`,
        `process.stdout.write(JSON.stringify(names));`,
    ].join("\n");
    const result = spawnSync(
        process.execPath,
        [
            "--conditions=plurnk-dev",
            `--import=${pathToFileURL(loaderPath).href}`,
            "--input-type=module",
            "-e",
            script,
        ],
        {
            cwd: serviceCore,
            env: { ...process.env, PLURNK_TIERS_SERVICE_ROOT: serviceCore },
            encoding: "utf8",
        },
    );
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
        throw new Error(`specimen discovery failed (${result.status}): ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout.trim()) as string[];
};

const USAGE = `usage: npm run tier:live [-- --specimen <name> ...] | npm run tier:demo [-- --specimen <name> ...]
Runs the real-model live or demo specimen corpus against PLURNK_BENCHLET_SERVICE_ROOT and PLURNK_BENCHLET_CLIENT_ROOT.
Reads: ~/.config/plurnk/.env, .env.defaults, PLURNK_MODEL, PLURNK_BENCHLET_SERVICE_ROOT, PLURNK_BENCHLET_CLIENT_ROOT.
Writes: <benchmarksHome>/tier-<live|demo>-<stamp>/{provenance.json,census.md,census.json,result.json,<session>/record.json}.
`;

if (import.meta.main) {
    const { values, positionals } = parseArgs({
        args: process.argv.slice(2),
        options: {
            tier: { type: "string" },
            specimen: { type: "string", multiple: true },
            help: { type: "boolean", short: "h" },
        },
        allowPositionals: true,
        strict: true,
    });
    if (values.help) {
        process.stdout.write(USAGE);
        process.exit(0);
    }
    const tier = values.tier;
    if (tier !== "live" && tier !== "demo") {
        throw new Error(`--tier must be 'live' or 'demo' (got ${JSON.stringify(tier)})`);
    }
    const operatorEnv = loadBenchmarkEnvironment(
        process.env.PLURNK_BENCHLET_OPERATOR_ENV,
        resolve(benchRoot, ".env.defaults"),
    );
    const model = selectedModel();
    const serviceRoot = resolve(benchRoot, process.env.PLURNK_BENCHLET_SERVICE_ROOT ?? "../plurnk-service");
    const configuredClient = process.env.PLURNK_BENCHLET_CLIENT_ROOT?.trim() || process.env.PLURNK_CLIENT_CHECKOUT?.trim();
    const clientRoot = configuredClient !== undefined && configuredClient !== ""
        ? resolve(benchRoot, configuredClient)
        : resolve(serviceRoot, "../plurnk");

    const files = tierFiles(tier);
    const requested = [...(values.specimen ?? []), ...positionals];
    const names = requested.length === 0
        ? []
        : selectTierSpecimens(requested, collectNamesInSubprocess(serviceRoot, files), tier);

    const runDir = tierRunDir(tier);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
        join(runDir, "provenance.json"),
        `${JSON.stringify(
            {
                schemaVersion: 1,
                tier,
                modelAlias: model,
                operatorEnv,
                startedAt: new Date().toISOString(),
                sources: {
                    bench: sourceProvenance(benchRoot),
                    ...(existsSync(serviceRoot) ? { service: sourceProvenance(serviceRoot) } : {}),
                    ...(existsSync(clientRoot) ? { client: sourceProvenance(clientRoot) } : {}),
                },
                webMaterialization: webMaterializationProvenance(process.env),
            },
            null,
            2,
        )}\n`,
    );

    const invocation = buildTierInvocation({
        tier,
        serviceRoot,
        clientRoot,
        runDir,
        files,
        names,
    });
    const child = spawnSync(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        stdio: "inherit",
        env: { ...process.env, ...invocation.env },
    });
    publishTierSessions({ tier, runDir, model });
    console.log(`tier:${tier} census: ${join(runDir, "census.md")}`);
    console.log(`tier:${tier} result: ${join(runDir, "result.json")}`);
    process.exit(child.status ?? 1);
}
