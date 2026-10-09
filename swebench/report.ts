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
import { summarizeDigestAccounting, type CostEvidence, type DigestAccountingInput } from "../src/accounting.ts";
import { median } from "../src/statistics.ts";
import { readDigest } from "../src/digest.ts";
import { baselinesFor, compareBaselines, renderComparison, type Comparison } from "./comparison.ts";
import { frictionOf, receiptOrigin, summarizeFriction, type DigestTurn, type Friction, type FrictionInput, type FrictionSummary } from "./friction.ts";
import { evaluationFailure, type EvaluationAttempt } from "./evaluator.ts";

export interface TrialRow {
    readonly instance: string;
    readonly attempt: number;
    readonly model: string;
    readonly outcome: string;
    readonly loopStatus: number;
    readonly reward: number | null;
    readonly emptyPatch: boolean;
    readonly exception: string | null;
    readonly evaluation: EvaluationAttempt | null;
    readonly turns: number;
    readonly requests: number | null;
    readonly rejectedEmissions: number | null;
    readonly tokens: { readonly input: number | null; readonly cached: number | null; readonly output: number | null; readonly reasoning: number | null } | null;
    readonly costUsd: number | null;
    readonly knownCostUsd: number | null;
    readonly pricedRequests: number | null;
    readonly costEvidence: CostEvidence | null;
    readonly wallMs: number | null;
    readonly friction: Friction;
    readonly webReferences: number; // web scheme references the first packet taught: doors the model was shown
    readonly webAttempts: number | null;   // model-issued http(s) operations, whatever the receipt said
    readonly webReads: number | null;      // the ones that were served (status < 400): a real leak
    readonly mcpCalls: number | null;
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
    readonly friction: FrictionSummary;
    readonly rejectedEmissions: number;
    readonly emptyPatches: number;
    readonly exceptions: Readonly<Record<string, number>>;
    readonly evaluations: { readonly trials: number; readonly problems: number };
    readonly edits: EditCensus;
    readonly isolation: { readonly webReferences: number; readonly webAttempts: number; readonly webReads: number; readonly mcpCalls: number; readonly trialsTouched: number; readonly classifiedTrials: number };
    readonly loopsEnded: Readonly<Record<string, number>>;   // loops the daemon ended (status ≥ 400), by status
    readonly graded: number;
    readonly resolved: number;
    readonly resolveRate: number | null;
    readonly spend: {
        readonly totalUsd: number | null;
        readonly knownUsd: number | null;
        readonly pricedTrials: number;
        readonly medianCostUsd: number | null;
        readonly medianGrossTokens: number | null;
        readonly medianTurns: number | null;
        readonly medianWallMs: number | null;
    };
}

interface DigestWorker { edit_census?: { edits: number; refused: number; revisits: number; forms: Record<string, number> } | null }
type Digest = DigestAccountingInput & FrictionInput & { workers?: DigestWorker[] };

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
const packetFiles = (digest: string, turns: readonly DigestTurn[], kind: "user"): string[] => turns
    .flatMap(({ artifact }) => (typeof artifact === "string" ? [join(digest, `${artifact}.${kind}.md`)] : []))
    .filter((path) => existsSync(path));

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
    const entries = (digest?.log_entries ?? []).filter((entry) => receiptOrigin(entry) === "authored");
    const classified = digest?.log_entries !== undefined && !digest.log_entries.some((entry) => entry.origin === "model" && receiptOrigin(entry) === "unknown");
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
        evaluation: json<EvaluationAttempt>(join(trialDir, "verifier", "evaluation.json")),
        turns: record.turns,
        requests: accounting?.providerRequests ?? null,
        rejectedEmissions: accounting?.rejectedEmissions ?? null,
        tokens: usage === null ? null : {
            input: usage.inputTokens ?? null,
            cached: usage.inputTokenDetails?.cacheReadTokens ?? null,
            output: usage.outputTokens ?? null,
            reasoning: usage.outputTokenDetails?.reasoningTokens ?? null,
        },
        costUsd: accounting?.costUsd === null || accounting?.costUsd === undefined ? null : Number(accounting.costUsd),
        knownCostUsd: accounting?.knownCostUsd === null || accounting?.knownCostUsd === undefined ? null : Number(accounting.knownCostUsd),
        pricedRequests: accounting?.pricedRequests ?? null,
        costEvidence: accounting?.costEvidence ?? null,
        wallMs: record.durationMs > 0 ? record.durationMs : null,
        friction: frictionOf(digest),
        webReferences: webReferencesTaught(digestDir(trialDir), digest?.turns ?? []),
        webAttempts: classified ? entries.filter((entry) => typeof entry.target === "string" && /^https?:\/\//u.test(entry.target)).length : null,
        webReads: classified ? entries.filter((entry) => typeof entry.target === "string" && /^https?:\/\//u.test(entry.target) && typeof entry.status_rx === "number" && entry.status_rx < 400).length : null,
        mcpCalls: classified ? entries.filter((entry) => typeof entry.op === "string" && aliases.has(entry.op.toLowerCase())).length : null,
        edits: editsOf(digest),
        evidence: trialDir,
    };
};

export const summarize = (rows: readonly TrialRow[]): CampaignSummary => {
    const exceptions: Record<string, number> = {};
    const loopsEnded: Record<string, number> = {};
    for (const row of rows) {
        if (row.loopStatus >= 400) count(loopsEnded, String(row.loopStatus));
        if (row.exception !== null) count(exceptions, row.exception.split(":")[0]!);
    }
    const graded = rows.filter((row) => row.reward !== null);
    const resolved = graded.filter((row) => row.reward === 1);
    const costs = rows.map((row) => row.costUsd).filter((value): value is number => value !== null);
    const knownCosts = rows.map((row) => row.knownCostUsd).filter((value): value is number => value !== null);
    return {
        trials: rows.length,
        friction: summarizeFriction(rows.map((row) => row.friction)),
        rejectedEmissions: sum(rows.map((row) => row.rejectedEmissions ?? 0)),
        emptyPatches: rows.filter((row) => row.emptyPatch).length,
        exceptions,
        evaluations: { trials: rows.filter((row) => row.evaluation !== null).length, problems: rows.filter((row) => evaluationFailure(row.evaluation) !== null).length },
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
            webAttempts: sum(rows.map((row) => row.webAttempts ?? 0)),
            webReads: sum(rows.map((row) => row.webReads ?? 0)),
            mcpCalls: sum(rows.map((row) => row.mcpCalls ?? 0)),
            trialsTouched: rows.filter((row) => (row.webReads ?? 0) + (row.mcpCalls ?? 0) > 0).length,
            classifiedTrials: rows.filter((row) => row.webAttempts !== null && row.mcpCalls !== null).length,
        },
        loopsEnded,
        graded: graded.length,
        resolved: resolved.length,
        resolveRate: graded.length === 0 ? null : resolved.length / graded.length,
        spend: {
            totalUsd: costs.length === 0 || costs.length !== rows.length ? null : sum(costs),
            knownUsd: knownCosts.length === 0 ? null : sum(knownCosts),
            pricedTrials: costs.length,
            medianCostUsd: metric(rows.map((row) => row.costUsd)),
            medianGrossTokens: metric(rows.map(({ tokens }) => tokens?.input == null || tokens.output === null ? null : tokens.input + tokens.output)),
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
    `- failed receipt evidence: ${summary.friction.failureTrials}/${summary.trials} trials`,
    ...(summary.friction.receipts === null ? ["- failed receipts: unknown"] : Object.entries(summary.friction.receipts).map(([origin, counts]) => `- failed ${origin} receipts by family: ${pairs(counts)}`)),
    `- distinct failed execution streams: ${num(summary.friction.executionStreams)} (${num(summary.friction.executionReceipts)} READ receipts; ${num(summary.friction.unaddressedExecutionReceipts)} without a resource address)`,
    "- receipt groups and stream counts overlap; command failure alone is not a harness defect",
    `- rejected emissions: ${summary.rejectedEmissions}`,
    `- empty patches: ${summary.emptyPatches}`,
    `- harness exceptions: ${pairs(summary.exceptions)}`,
    `- evaluator evidence: ${summary.evaluations.trials}/${summary.trials} trials; latest attempts with problems: ${summary.evaluations.problems}`,
    ...rows.flatMap((row) => {
        const failure = evaluationFailure(row.evaluation);
        return failure === null ? [] : [`- ${row.instance} attempt ${row.attempt}: evaluator: ${failure}; evidence ${join(row.evidence, "oracle", row.evaluation!.runId)}`];
    }),
    `- turn evidence: ${summary.friction.turnTrials}/${summary.trials} trials; raw content ${num(summary.friction.turns?.rawEmissions ?? null)}/${num(summary.friction.turns?.modelTurns ?? null)} model turns`,
    `- fence-free content: ${num(summary.friction.turns?.fenceFree ?? null)}; with admitted content operations: ${num(summary.friction.turns?.fenceFreeAdmitted ?? null)}; engine no-operation outcomes: ${num(summary.friction.turns?.noOperation ?? null)}`,
    `- EDITs: ${summary.edits.count} (${pairs(summary.edits.forms)}) · refused ${summary.edits.refused} · revisits ${summary.edits.revisits}`,
    `- isolation witness: ${summary.isolation.webReferences} web references taught; ${summary.isolation.classifiedTrials}/${summary.trials} trials with classified operations: ${summary.isolation.webAttempts} model-issued web operations attempted, ${summary.isolation.webReads} served, ${summary.isolation.mcpCalls} MCP calls; ${summary.isolation.trialsTouched} trials leaked`,
    `- loops ended by the daemon (status ≥ 400): ${pairs(summary.loopsEnded)}`,
    "",
    "## Verdicts",
    "",
    `- resolved ${summary.resolved} of ${summary.graded} graded${summary.resolveRate === null ? "" : ` (${(summary.resolveRate * 100).toFixed(1)}%)`}`,
    "",
    "## Spend",
    "",
    `- total ${usd(summary.spend.totalUsd)} · median per rollout ${usd(summary.spend.medianCostUsd)} · median gross tokens ${num(summary.spend.medianGrossTokens)} · median turns ${num(summary.spend.medianTurns)} · median wall ${minutes(summary.spend.medianWallMs)}`,
    `- known subtotal ${usd(summary.spend.knownUsd)} · complete costs ${summary.spend.pricedTrials}/${summary.trials} trials; medians exclude incomplete costs`,
    ...rows.map((row) => `- ${row.instance} attempt ${row.attempt}: priced requests ${row.pricedRequests ?? "—"}/${row.requests ?? "—"}; ${row.costEvidence === null ? "cost evidence unavailable" : pairs(row.costEvidence)}; known subtotal ${usd(row.knownCostUsd)}`),
    "",
    // {§swebench-comparison} — the study's statistics, after friction, verdicts and spend, before the rows.
    ...(comparison === null ? [] : renderComparison(comparison, `Plurnk · ${campaign.model ?? "?"}`)),
    "## Trials",
    "",
    "| instance | att | outcome | loop | reward | empty | turns | req | in | cached | out | reason | cost | wall | web | mcp | failed authored receipts | edits | exception |",
    "| --- | ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
    ...rows.map((row) => `| ${row.instance} | ${row.attempt} | ${row.outcome} | ${row.loopStatus} | ${row.reward ?? "—"} | ${row.emptyPatch ? "yes" : ""} | ${row.turns} | ${row.requests ?? "—"} | ${row.tokens?.input ?? "—"} | ${row.tokens?.cached ?? "—"} | ${row.tokens?.output ?? "—"} | ${row.tokens?.reasoning ?? "—"} | ${usd(row.costUsd)} | ${minutes(row.wallMs)} | ${row.webAttempts ?? "—"}/${row.webReads ?? "—"} | ${row.mcpCalls ?? "—"} | ${row.friction.failures === null ? "—" : pairs(row.friction.failures.receipts.authored)} | ${row.edits === null ? "—" : `${row.edits.count}/${row.edits.refused}/${row.edits.revisits}`} | ${row.exception ?? ""} |`),
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
    const evaluation = evaluationFailure(json<EvaluationAttempt>(join(trialDir, "verifier", "evaluation.json")));
    const terminal = engineTerminal(trialDir);
    const decoration = ex?.exception_type === "AgentCancelledError" ? "externally cancelled" : terminal;
    const details = [decoration, evaluation === null ? null : `evaluator: ${evaluation}`].filter((value) => value !== null);
    const decorated = details.length === 0 ? "" : ` (${details.join("; ")})`;
    if (reward !== null && typeof reward.reward === "number") {
        return reward.reward === 1 ? `pass${decorated}` : `fail: reward ${reward.reward}${decorated}`;
    }
    if (evaluation !== null) return `harness: evaluator: ${evaluation}`;
    if (terminal !== null) return `fail: ${terminal}`;
    if (ex !== null) return `agent: ${detail}`;
    return "harness: no verifier verdict";
};

// {§swebench-evaluator}: a captured candidate can be regraded, not repurchased to repair its grader.
export const requireSettledEvaluation = (trialDir: string): void => {
    if (!existsSync(join(trialDir, "artifacts", "model.patch"))) return;
    const evaluation = json<EvaluationAttempt>(join(trialDir, "verifier", "evaluation.json"));
    const reward = json<{ reward?: number }>(join(trialDir, "verifier", "reward.json"));
    if (evaluationFailure(evaluation) === null && typeof reward?.reward === "number") return;
    throw new Error(`candidate retained at ${trialDir}; retry swebench/evaluate.ts on its unchanged artifacts/model.patch before resuming, or explicitly skip the specimen`);
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
