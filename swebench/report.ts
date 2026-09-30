// {§swebench-profiles} — one campaign directory (swebench/campaign.sh) read into one sheet, friction
// first: refused operations by family, empty patches, harness exceptions, the isolation witness
// (web references the first packet taught, model-issued web reads, MCP calls), then the oracle
// verdicts, then spend. Every number comes from the trial's own record and the daemon's digest
// ({§digest-boundary}); nothing is re-derived. `--verdict <trial>` is the loop's halt rule: only a
// clean pass, oracle resolved and client exited 0, lets the campaign spend on the next trial.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readTrialDir } from "../src/ingest.ts";
import { PUBLISHED_MARKER } from "../src/publish.ts";
import { summarizeDigestAccounting, type DigestAccountingInput } from "../src/accounting.ts";
import { median } from "../src/statistics.ts";
import { readDigest } from "../src/digest.ts";
import { baselinesFor, compareBaselines, renderComparison, type Comparison } from "./comparison.ts";

export interface TrialRow {
    readonly instance: string;
    readonly attempt: number;
    readonly model: string;
    readonly outcome: string;
    readonly loopStatus: number;
    readonly reward: number | null;
    readonly emptyPatch: boolean;
    readonly exception: string | null;
    readonly turns: number;
    readonly requests: number | null;
    readonly rejectedEmissions: number | null;
    readonly tokens: { readonly input: number; readonly cached: number; readonly output: number; readonly reasoning: number } | null;
    readonly costUsd: number | null;
    readonly wallMs: number | null;
    readonly emptyTurns: number;    // emissions with no fence at all: prose, or a foreign tool-call grammar (plurnk-service#840)
    readonly webReferences: number; // web scheme references the first packet taught: doors the model was shown
    readonly webAttempts: number;   // model-issued http(s) operations, whatever the receipt said
    readonly webReads: number;      // the ones that were served (status < 400): a real leak
    readonly mcpCalls: number;
    readonly refused: Readonly<Record<string, number>>;
    // the service's `§digest-edit-census` (service): every model EDIT by authored form, refusals, and revisits.
    readonly edits: EditCensus | null;
    readonly evidence: string;
}

export interface EditCensus {
    readonly count: number;
    readonly refused: number;
    readonly revisits: number;
    readonly forms: Readonly<Record<string, number>>;
}

export interface CampaignSummary {
    readonly trials: number;
    readonly refusedByOp: Readonly<Record<string, number>>;
    readonly rejectedEmissions: number;
    readonly emptyPatches: number;
    readonly exceptions: Readonly<Record<string, number>>;
    readonly emptyTurns: number;
    readonly edits: EditCensus;
    readonly isolation: { readonly webReferences: number; readonly webAttempts: number; readonly webReads: number; readonly mcpCalls: number; readonly trialsTouched: number };
    readonly loopsEnded: Readonly<Record<string, number>>;   // loops the daemon ended (status ≥ 400), by status
    readonly graded: number;
    readonly resolved: number;
    readonly resolveRate: number | null;
    readonly spend: {
        readonly totalUsd: number | null;
        readonly medianCostUsd: number | null;
        readonly medianGrossTokens: number | null;
        readonly medianTurns: number | null;
        readonly medianWallMs: number | null;
    };
}

interface LogEntry { origin?: string; op?: string | null; target?: string | null; status_rx?: number | null }
// {§share-packet-names}: a turn's packet files share the stem digest.json records as `artifact`
// (null when the turn wrote none); the array is the digest's own turn order.
export interface DigestTurn { artifact?: string | null }
interface DigestWorker { edit_census?: { edits: number; refused: number; revisits: number; forms: Record<string, number> } | null }
interface Digest extends DigestAccountingInput { log_entries?: LogEntry[]; turns?: DigestTurn[]; workers?: DigestWorker[] }

// The trial's EDIT census is the sum over its workers of what the digest counted; a digest
// without the census (an older service) leaves it null rather than zero.
const editsOf = (digest: Digest | null): EditCensus | null => {
    const censuses = (digest?.workers ?? []).map((worker) => worker.edit_census).filter((census) => census !== undefined);
    if (censuses.length === 0) return null;
    const forms: Record<string, number> = {};
    for (const census of censuses) for (const [form, n] of Object.entries(census?.forms ?? {})) if (n > 0) forms[form] = (forms[form] ?? 0) + n;
    return {
        count: sum(censuses.map((census) => census?.edits ?? 0)),
        refused: sum(censuses.map((census) => census?.refused ?? 0)),
        revisits: sum(censuses.map((census) => census?.revisits ?? 0)),
        forms,
    };
};

const json = <T>(path: string): T | null => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : null;
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const count = (target: Record<string, number>, key: string): void => { target[key] = (target[key] ?? 0) + 1; };
const metric = (values: Array<number | null | undefined>): number | null => {
    const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    return present.length === 0 ? null : median(present);
};

// The masked definitions name the operator's MCP servers; a model op spelled like one is a call.
const maskedAliases = (trialDir: string): Set<string> => {
    const isolation = json<{ masked?: string[] }>(join(trialDir, "candidate-isolation.json"));
    return new Set((isolation?.masked ?? []).flatMap((name) => {
        const match = /^PLURNK_(?:MCP|A2A)_([a-z][a-z0-9_]*)$/.exec(name);
        return match === null ? [] : [match[1]!.replaceAll("_", "-")];
    }));
};

const digestDir = (trialDir: string): string => {
    const marker = join(trialDir, PUBLISHED_MARKER);
    const published = existsSync(marker) ? readFileSync(marker, "utf8").trim() : "";
    return join(published === "" ? join(trialDir, "agent") : published, "digest");
};

// The schemes whose manifests declare the `web` trait. The sheet reads the packet the model saw,
// not the manifests: a reference row in the first packet is a door the model was shown.
const WEB_SCHEMES: ReadonlySet<string> = new Set(["https", "wss"]);
// The packet files of the given kind, in the digest's turn order: the stems digest.json names,
// kept when the turn wrote that file.
const packetFiles = (digest: string, turns: readonly DigestTurn[], kind: "assistant" | "user"): string[] => turns
    .flatMap(({ artifact }) => (typeof artifact === "string" ? [join(digest, `${artifact}.${kind}.md`)] : []))
    .filter((path) => existsSync(path));

// An emission the parser could admit nothing from: no line opens a fence. Counted from the raw
// assistant packets, so a model's native tool-call markup and plain prose both show as friction.
export const emptyTurnsOf = (digest: string, turns: readonly DigestTurn[]): number => packetFiles(digest, turns, "assistant")
    .filter((path) => !/^ {0,3}```/mu.test(readFileSync(path, "utf8"))).length;

export const webReferencesTaught = (digest: string, turns: readonly DigestTurn[]): number => {
    const [first] = packetFiles(digest, turns, "user");
    if (first === undefined) return 0;
    const taught = new Set([...readFileSync(first, "utf8").matchAll(/worker:\/\/\/_plurnk\/plurnk\/([a-z0-9-]+)\.md/gu)].map((match) => match[1]!));
    return [...taught].filter((name) => WEB_SCHEMES.has(name)).length;
};

export const readTrialRow = (trialDir: string, attempt: number): TrialRow | null => {
    const record = readTrialDir(trialDir, { harness: "swebench" });
    if (record === null) return null;
    const result = json<{ exception_info?: { exception_type?: string; exception_message?: string } | null }>(join(trialDir, "result.json"));
    const reward = json<{ reward?: number; empty_patch?: number }>(join(trialDir, "verifier", "reward.json"));
    const evidence = join(digestDir(trialDir), "digest.json");
    const digest = existsSync(evidence) ? readDigest<Digest>(evidence) : null;
    const accounting = digest === null ? null : summarizeDigestAccounting(digest);
    const usage = accounting?.usage ?? null;
    const aliases = maskedAliases(trialDir);
    const entries = (digest?.log_entries ?? []).filter((entry) => entry.origin !== "_plurnk");
    const refused: Record<string, number> = {};
    for (const entry of entries) if (typeof entry.status_rx === "number" && entry.status_rx >= 400) count(refused, entry.op ?? "?");
    const ex = result?.exception_info ?? null;
    return {
        instance: record.taskId,
        attempt,
        model: record.model,
        outcome: record.outcome,
        loopStatus: record.status,
        reward: typeof reward?.reward === "number" ? reward.reward : record.reward ?? null,
        emptyPatch: reward?.empty_patch === 1,
        exception: ex?.exception_type === undefined ? null : `${ex.exception_type}${ex.exception_message ? `: ${ex.exception_message}` : ""}`,
        turns: record.turns,
        requests: accounting?.providerRequests ?? null,
        rejectedEmissions: accounting?.rejectedEmissions ?? null,
        tokens: usage === null ? null : {
            input: usage.inputTokens ?? 0,
            cached: usage.inputTokenDetails?.cacheReadTokens ?? 0,
            output: usage.outputTokens ?? 0,
            reasoning: usage.outputTokenDetails?.reasoningTokens ?? 0,
        },
        costUsd: accounting?.costUsd === null || accounting?.costUsd === undefined ? null : Number(accounting.costUsd),
        wallMs: record.durationMs > 0 ? record.durationMs : null,
        emptyTurns: emptyTurnsOf(digestDir(trialDir), digest?.turns ?? []),
        webReferences: webReferencesTaught(digestDir(trialDir), digest?.turns ?? []),
        webAttempts: entries.filter((entry) => typeof entry.target === "string" && /^https?:\/\//u.test(entry.target)).length,
        webReads: entries.filter((entry) => typeof entry.target === "string" && /^https?:\/\//u.test(entry.target) && typeof entry.status_rx === "number" && entry.status_rx < 400).length,
        mcpCalls: entries.filter((entry) => typeof entry.op === "string" && aliases.has(entry.op.toLowerCase())).length,
        refused,
        edits: editsOf(digest),
        evidence: trialDir,
    };
};

export const summarize = (rows: readonly TrialRow[]): CampaignSummary => {
    const refusedByOp: Record<string, number> = {};
    const exceptions: Record<string, number> = {};
    const loopsEnded: Record<string, number> = {};
    for (const row of rows) {
        if (row.loopStatus >= 400) count(loopsEnded, String(row.loopStatus));
        for (const [op, n] of Object.entries(row.refused)) refusedByOp[op] = (refusedByOp[op] ?? 0) + n;
        if (row.exception !== null) count(exceptions, row.exception.split(":")[0]!);
    }
    const graded = rows.filter((row) => row.reward !== null);
    const resolved = graded.filter((row) => row.reward === 1);
    const costs = rows.map((row) => row.costUsd).filter((value): value is number => value !== null);
    return {
        trials: rows.length,
        refusedByOp,
        rejectedEmissions: sum(rows.map((row) => row.rejectedEmissions ?? 0)),
        emptyPatches: rows.filter((row) => row.emptyPatch).length,
        exceptions,
        emptyTurns: sum(rows.map((row) => row.emptyTurns)),
        edits: {
            count: sum(rows.map((row) => row.edits?.count ?? 0)),
            refused: sum(rows.map((row) => row.edits?.refused ?? 0)),
            revisits: sum(rows.map((row) => row.edits?.revisits ?? 0)),
            forms: rows.reduce<Record<string, number>>((forms, row) => {
                for (const [form, n] of Object.entries(row.edits?.forms ?? {})) forms[form] = (forms[form] ?? 0) + n;
                return forms;
            }, {}),
        },
        isolation: {
            webReferences: sum(rows.map((row) => row.webReferences)),
            webAttempts: sum(rows.map((row) => row.webAttempts)),
            webReads: sum(rows.map((row) => row.webReads)),
            mcpCalls: sum(rows.map((row) => row.mcpCalls)),
            trialsTouched: rows.filter((row) => row.webReads + row.mcpCalls > 0).length,
        },
        loopsEnded,
        graded: graded.length,
        resolved: resolved.length,
        resolveRate: graded.length === 0 ? null : resolved.length / graded.length,
        spend: {
            totalUsd: costs.length === 0 ? null : sum(costs),
            medianCostUsd: metric(rows.map((row) => row.costUsd)),
            medianGrossTokens: metric(rows.map((row) => row.tokens === null ? null : row.tokens.input + row.tokens.output)),
            medianTurns: metric(rows.map((row) => row.turns)),
            medianWallMs: metric(rows.map((row) => row.wallMs)),
        },
    };
};

// A re-run of the same instance and attempt supersedes its earlier row: the campaign re-buys a
// trial only when its verdict was not accepted, and the later verdict is the one that stands.
export const latestLaunches = <T extends { instance: string; attempt: number }>(launched: readonly T[]): T[] =>
    [...new Map(launched.map((entry) => [`${entry.instance}\t${entry.attempt}`, entry])).values()];

const usd = (value: number | null): string => value === null ? "—" : `$${value.toFixed(3)}`;
const num = (value: number | null): string => value === null ? "—" : String(Math.round(value));
const minutes = (ms: number | null): string => ms === null ? "—" : `${(ms / 60_000).toFixed(1)}m`;
const pairs = (record: Readonly<Record<string, number>>): string => Object.entries(record).map(([key, n]) => `${key} ${n}`).join(", ") || "none";

export const render = (campaign: { corpus?: string; model?: string | null; serviceHead?: string; clientHead?: string; ids?: string[] }, rows: readonly TrialRow[], summary: CampaignSummary, comparison: Comparison | null = null): string => [
    `# swebench campaign — ${campaign.corpus ?? "?"} on ${campaign.model ?? "preflight"}`,
    "",
    `service ${(campaign.serviceHead ?? "?").slice(0, 12)} · client ${(campaign.clientHead ?? "?").slice(0, 12)} · ${summary.trials} trials of ${campaign.ids?.length ?? "?"} instances`,
    "",
    "## Friction",
    "",
    `- refused or failed operations by family: ${pairs(summary.refusedByOp)}`,
    `- rejected emissions: ${summary.rejectedEmissions}`,
    `- empty patches: ${summary.emptyPatches}`,
    `- harness exceptions: ${pairs(summary.exceptions)}`,
    `- indecipherable turns (no fence emitted): ${summary.emptyTurns}`,
    `- EDITs: ${summary.edits.count} (${pairs(summary.edits.forms)}) · refused ${summary.edits.refused} · revisits ${summary.edits.revisits}`,
    `- isolation witness: ${summary.isolation.webReferences} web references taught, ${summary.isolation.webAttempts} model-issued web operations attempted, ${summary.isolation.webReads} served, ${summary.isolation.mcpCalls} MCP calls; ${summary.isolation.trialsTouched} trials leaked`,
    `- loops ended by the daemon (status ≥ 400): ${pairs(summary.loopsEnded)}`,
    "",
    "## Verdicts",
    "",
    `- resolved ${summary.resolved} of ${summary.graded} graded${summary.resolveRate === null ? "" : ` (${(summary.resolveRate * 100).toFixed(1)}%)`}`,
    "",
    "## Spend",
    "",
    `- total ${usd(summary.spend.totalUsd)} · median per rollout ${usd(summary.spend.medianCostUsd)} · median gross tokens ${num(summary.spend.medianGrossTokens)} · median turns ${num(summary.spend.medianTurns)} · median wall ${minutes(summary.spend.medianWallMs)}`,
    "",
    // {§swebench-comparison} — the study's statistics, after friction, verdicts and spend, before the rows.
    ...(comparison === null ? [] : renderComparison(comparison, `Plurnk · ${campaign.model ?? "?"}`)),
    "## Trials",
    "",
    "| instance | att | outcome | loop | reward | empty | turns | req | in | cached | out | reason | cost | wall | web | mcp | refused | edits | exception |",
    "| --- | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...rows.map((row) => `| ${row.instance} | ${row.attempt} | ${row.outcome} | ${row.loopStatus} | ${row.reward ?? "—"} | ${row.emptyPatch ? "yes" : ""} | ${row.turns} | ${row.requests ?? "—"} | ${row.tokens === null ? "—" : row.tokens.input} | ${row.tokens === null ? "—" : row.tokens.cached} | ${row.tokens === null ? "—" : row.tokens.output} | ${row.tokens === null ? "—" : row.tokens.reasoning} | ${usd(row.costUsd)} | ${minutes(row.wallMs)} | ${row.webAttempts}/${row.webReads} | ${row.mcpCalls} | ${pairs(row.refused)} | ${row.edits === null ? "—" : `${row.edits.count}/${row.edits.refused}/${row.edits.revisits}`} | ${row.exception ?? ""} |`),
    "",
].join("\n");

// {§swebench-trial} — the loop's halt rule. `pass` is a clean pass; anything else names what to read:
// `fail` the oracle refused a clean run, `agent` the candidate did not exit cleanly (struck out,
// cancelled, out of time), `harness` the bench itself left no record or no verdict.
// {§swebench-trial} — the halt rule. The oracle grades the patch, whatever ended the loop
// (plurnk-service#840): a reward is the verdict, and a loop the engine ended decorates it, so the strict
// halt still stops to read it while the clean halt runs on. Without a reward, an engine terminal —
// turn ceiling, strike threshold, cycle, timeout — is the model's outcome, never the agent's (#46).
const ENGINE_TERMINALS: ReadonlyMap<number, string> = new Map([
    [429, "turn ceiling exhausted"], [500, "strike threshold"], [508, "cycle detected"], [504, "loop timeout"],
]);
const engineTerminal = (trialDir: string): string | null => {
    const root = json<{ finalStatus?: number }>(join(trialDir, "agent", "plurnk.json"));
    return root?.finalStatus === undefined ? null : ENGINE_TERMINALS.get(root.finalStatus) ?? null;
};
export const verdictOf = (trialDir: string): string => {
    const result = json<{ exception_info?: { exception_type?: string; exception_message?: string } | null }>(join(trialDir, "result.json"));
    if (result === null) return "harness: no result.json";
    const ex = result.exception_info ?? null;
    const detail = ex === null ? "" : `${ex.exception_type ?? "?"}${ex.exception_message ? `: ${ex.exception_message}` : ""}`;
    if (ex?.exception_type === "AgentSpawnError") return `harness: ${detail}`;
    const reward = json<{ reward?: number }>(join(trialDir, "verifier", "reward.json"));
    const terminal = engineTerminal(trialDir);
    const decoration = ex?.exception_type === "AgentCancelledError" ? "externally cancelled" : terminal;
    const decorated = decoration === null ? "" : ` (${decoration})`;
    if (reward !== null && typeof reward.reward === "number") {
        return reward.reward === 1 ? `pass${decorated}` : `fail: reward ${reward.reward}${decorated}`;
    }
    if (terminal !== null) return `fail: ${terminal}`;
    if (ex !== null) return `agent: ${detail}`;
    return "harness: no verifier verdict";
};

if (import.meta.main) {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { json: { type: "boolean" }, verdict: { type: "string" } } });
    if (values.verdict !== undefined) {
        if (positionals.length !== 0) throw new Error("usage: swebench/report.ts --verdict <trial-directory>");
        console.log(verdictOf(resolve(values.verdict)));
        process.exit(0);
    }
    if (positionals.length !== 1) throw new Error("usage: swebench/report.ts <campaign-directory> [--json] | --verdict <trial-directory>");
    const dir = resolve(positionals[0]!);
    const campaign = json<{ corpus?: string; model?: string | null; serviceHead?: string; clientHead?: string; ids?: string[] }>(join(dir, "campaign.json")) ?? {};
    const launched = readFileSync(join(dir, "trials.tsv"), "utf8").split("\n").filter((line) => line.trim() !== "")
        .map((line) => { const [instance, attempt, rc, trial] = line.split("\t"); return { instance: instance!, attempt: Number(attempt), rc: Number(rc), trial: trial ?? "" }; });
    const rows = latestLaunches(launched).flatMap(({ trial, attempt }) => { const row = trial === "" ? null : readTrialRow(trial, attempt); return row === null ? [] : [row]; });
    const summary = summarize(rows);
    const baselines = campaign.corpus === undefined ? null : baselinesFor(campaign.corpus);
    const comparison = baselines === null ? null : compareBaselines(rows, baselines);
    if (values.json) console.log(JSON.stringify({ campaign, launched, rows, summary, comparison }, null, 2));
    else process.stdout.write(render(campaign, rows, summary, comparison));
}
