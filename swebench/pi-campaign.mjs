// {§swebench-pi} Schedule independent native processes; never interleave agent loops here.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { corpusIds, planTrials } from "./plan.ts";
import { runToFiles } from "./run.ts";
import { requireSettledEvaluation } from "./report.ts";
import { evaluationFailure } from "./evaluator.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

const evidenceOf = (artifact) => {
    const read = (path) => artifact && existsSync(join(artifact, path)) ? json(join(artifact, path)) : null;
    return { summary: read("agent/summary.json"), reward: read("verifier/reward.json"),
        exception: read("result.json")?.exception_info ?? null, evaluation: read("verifier/evaluation.json") };
};

const hasCandidateOutcome = ({ summary, reward, exception, evaluation }) => reward && summary?.requests > 0
    && (exception === null || ["AgentExitError", "AgentTimeoutError", "AgentCancelledError"].includes(exception.exception_type))
    && evaluationFailure(evaluation) === null;

const campaignPrice = (summaries, field, knownField, priced) => {
    const totals = summaries.map((summary) => summary && priced(summary) === summary.requests ? summary[field] ?? null : null);
    const known = summaries.map((summary) => !summary ? null : Object.hasOwn(summary, knownField)
        ? summary[knownField] : priced(summary) > 0 || summary.requests === 0 ? summary[field] ?? null : null)
        .filter((amount) => amount !== null);
    return {
        total: totals.every((amount) => amount !== null) ? totals.reduce((sum, amount) => sum + amount, 0) : null,
        known: known.length > 0 || summaries.length === 0 ? known.reduce((sum, amount) => sum + amount, 0) : null,
    };
};

export async function runCampaign({ corpus, profile, out, attempts, jobs, signal }, execute = runToFiles) {
    if (![attempts, jobs].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error("attempts and jobs must be positive integers");
    mkdirSync(out, { recursive: true });
    const planPath = join(out, "plan.json");
    const plan = { corpus: json(corpus), profile: json(profile), attempts,
        trials: planTrials({ ids: corpusIds(json(corpus)), attempts, limit: 0, only: [], skip: [], done: new Set() }) };
    if (existsSync(planPath) && JSON.stringify(json(planPath)) !== JSON.stringify(plan)) throw new Error("Pi campaign configuration changed; use a new output directory");
    save(planPath, plan);
    const resultsPath = join(out, "results.jsonl");
    // {§swebench-evaluator}: grading recovery appends a new observation of the same candidate;
    // setup failures may run again, but retained candidates are never repurchased to repair grading.
    const recorded = existsSync(resultsPath) ? readFileSync(resultsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const latest = new Map(recorded.map((entry) => [`${entry.id}/${entry.attempt}`, entry]));
    for (const [key, entry] of latest) {
        if (!entry.pause || !entry.artifact || !existsSync(join(entry.artifact, "artifacts", "model.patch"))) continue;
        requireSettledEvaluation(entry.artifact);
        const evidence = evidenceOf(entry.artifact);
        if (!hasCandidateOutcome(evidence)) throw new Error(`candidate retained at ${entry.artifact}; inspect its missing trial evidence before resuming`);
        const recovered = { ...entry, ...evidence, pause: false, regradedAt: new Date().toISOString() };
        appendFileSync(resultsPath, JSON.stringify(recovered) + "\n");
        latest.set(key, recovered);
    }
    const completed = [...latest.values()].filter(({ pause }) => !pause);
    const writeSummary = () => {
        const summaries = completed.map(({ summary }) => summary);
        const charged = campaignPrice(summaries, "chargedUsd", "knownChargedUsd", (s) => s.requests - s.unpricedRequests);
        const repriced = campaignPrice(summaries, "repricedUsd", "knownRepricedUsd", (s) => s.responsesWithTokenBreakdown);
        save(join(out, "summary.json"), { planned: plan.trials.length, finished: completed.length,
            passes: completed.filter(({ reward }) => reward?.reward === 1).length,
            chargedUsd: charged.total, knownChargedUsd: charged.known,
            repricedUsd: repriced.total, knownRepricedUsd: repriced.known,
            unpricedRequests: completed.reduce((n, { summary }) => n + (summary?.unpricedRequests ?? 0), 0),
            paused: completed.filter(({ pause }) => pause).map(({ id, attempt }) => ({ id, attempt })),
        });
    };
    writeSummary();
    const remaining = plan.trials.filter(({ id, attempt }) => latest.get(`${id}/${attempt}`)?.pause !== false);
    let halted = false;
    const run = async () => {
        while (!halted && !signal?.aborted && remaining.length) {
            const trial = remaining.shift();
            const label = `${trial.attempt}-${trial.id}`;
            const stdoutPath = join(out, `${label}.stdout.log`);
            const stderrPath = join(out, `${label}.stderr.log`);
            console.log(`${new Date().toISOString()} start ${label}`);
            const execution = await execute(process.execPath, [join(directory, "pi.mjs"), "--instance", trial.id, "--profile", profile],
                { cwd: resolve(directory, ".."), env: process.env, signal, stdoutPath, stderrPath });
            const artifact = readFileSync(stdoutPath, "utf8").match(/^artifact=(.+)$/m)?.[1];
            const evidence = evidenceOf(artifact);
            const pause = execution.status !== 0 || !hasCandidateOutcome(evidence);
            const entry = { ...trial, artifact, exit: execution.status, ...evidence, pause, finishedAt: new Date().toISOString() };
            appendFileSync(resultsPath, JSON.stringify(entry) + "\n");
            completed.push(entry);
            writeSummary();
            console.log(`${entry.finishedAt} finish ${label} reward=${entry.reward?.reward ?? "ungraded"} charged=${entry.summary?.chargedUsd ?? "unknown"} pause=${pause}`);
            if (pause) halted = true;
        }
    };
    await Promise.all(Array.from({ length: jobs }, run));
    if (halted) throw new Error(`Pi campaign paused for review; see ${resultsPath}`);
}

if (import.meta.main) {
    const { values } = parseArgs({ options: { corpus: { type: "string" }, profile: { type: "string" }, out: { type: "string" },
        attempts: { type: "string", default: "3" }, jobs: { type: "string", default: "1" } } });
    if (!values.corpus || !values.profile || !values.out) throw new Error("usage: node swebench/pi-campaign.mjs --corpus FILE --profile FILE --out DIR [--attempts 3] [--jobs 1]");
    const abort = new AbortController();
    process.once("SIGTERM", () => abort.abort(new Error("Pi campaign stopped")));
    process.once("SIGINT", () => abort.abort(new Error("Pi campaign interrupted")));
    await runCampaign({ corpus: resolve(values.corpus), profile: resolve(values.profile), out: resolve(values.out),
        attempts: Number(values.attempts), jobs: Number(values.jobs), signal: abort.signal });
}
