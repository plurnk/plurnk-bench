// {§swebench-profiles} — the (instance, attempt) pairs one campaign launch runs, in corpus order:
// --only and --skip narrow the corpus, a resumed campaign drops every pair its trials.tsv already
// records as done — the trials its --halt-on policy let run on: a clean pass under `pass`, every
// graded trial under `clean` — and every id its accepted file names (a failure read and accepted
// as the model's, remembered so no later launch re-buys it), and --limit bounds what this launch
// runs.
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { latestLaunches, requireSettledEvaluation, verdictOf } from "./report.ts";

export interface PlannedTrial { readonly id: string; readonly attempt: number }
// The campaign's --halt-on policy; what it lets run on is what a resume keeps.
export type HaltPolicy = "pass" | "clean";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

// A corpus is a list of ids, or an object carrying one under `ids`, `instances`, `tasks` or any key.
export const corpusIds = (corpus: unknown): string[] => {
    if (strings(corpus)) return corpus;
    const record = corpus as Record<string, unknown>;
    const found = [record.ids, record.instances, record.tasks, ...Object.values(record)].find(strings);
    if (found === undefined) throw new Error("corpus carries no ids");
    return found;
};

// The verdicts a policy lets run on, exactly as campaign.sh halts: under `pass` only a clean pass,
// under `clean` everything the oracle graded (a miss is the model's outcome), never an agent or
// harness verdict.
export const letsRunOn = (policy: HaltPolicy, verdict: string): boolean =>
    policy === "pass" ? verdict === "pass" : !/^(agent|harness):/.test(verdict);

// trials.tsv columns: instance, attempt, rc, trial, published, verdict. Current grading evidence
// may supersede the recorded verdict without replacing that launch ({§swebench-evaluator}).
export const donePairs = (trialsTsv: string, policy: HaltPolicy, selection: { skip?: readonly string[]; only?: readonly string[] } = {}): Set<string> => {
    const rows = trialsTsv.split("\n").filter((line) => line.trim() !== "").map((line) => {
        const [instance, attempt, , trial, , verdict] = line.split("\t");
        return { instance: instance!, attempt: Number(attempt), trial, verdict: verdict ?? "" };
    });
    return new Set(latestLaunches(rows).filter((row) => {
        if (selection.skip?.includes(row.instance)) return true;
        if (selection.only?.length && !selection.only.includes(row.instance)) return false;
        const retained = row.trial !== undefined && row.trial !== "" && existsSync(row.trial);
        const verdict = retained ? verdictOf(row.trial!) : row.verdict;
        if (letsRunOn(policy, verdict)) return true;
        if (retained) requireSettledEvaluation(row.trial!);
        return false;
    }).map(({ instance, attempt }) => `${instance}\t${attempt}`));
};

export const planTrials = (input: {
    readonly ids: readonly string[]; readonly attempts: number; readonly limit: number;
    readonly only: readonly string[]; readonly skip: readonly string[]; readonly done: ReadonlySet<string>;
}): PlannedTrial[] => {
    const only = new Set(input.only);
    const skip = new Set(input.skip);
    const chosen = input.ids.filter((id) => (only.size === 0 || only.has(id)) && !skip.has(id));
    const pairs = Array.from({ length: input.attempts }, (_, index) => index + 1)
        .flatMap((attempt) => chosen.map((id) => ({ id, attempt })))
        .filter(({ id, attempt }) => !input.done.has(`${id}\t${attempt}`));
    return input.limit > 0 ? pairs.slice(0, input.limit) : pairs;
};

if (import.meta.main) {
    const { values } = parseArgs({ options: {
        corpus: { type: "string" }, attempts: { type: "string", default: "1" }, limit: { type: "string", default: "0" },
        only: { type: "string", default: "" }, skip: { type: "string", default: "" }, trials: { type: "string" }, accepted: { type: "string" },
        "halt-on": { type: "string", default: "pass" },
    } });
    if (values.corpus === undefined) throw new Error("usage: swebench/plan.ts --corpus <file> [--attempts N] [--limit N] [--only id,id] [--skip id,id] [--trials trials.tsv] [--accepted file] [--halt-on pass|clean]");
    const policy = values["halt-on"];
    if (policy !== "pass" && policy !== "clean") throw new Error("--halt-on takes pass or clean");
    const list = (value: string): string[] => value.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const accepted = values.accepted === undefined ? [] : list(readFileSync(values.accepted, "utf8").replace(/\n/g, ","));
    const pairs = planTrials({
        ids: corpusIds(JSON.parse(readFileSync(values.corpus, "utf8"))),
        attempts: Number(values.attempts), limit: Number(values.limit), only: list(values.only), skip: [...list(values.skip), ...accepted],
        done: values.trials === undefined ? new Set() : donePairs(readFileSync(values.trials, "utf8"), policy, {
            skip: [...list(values.skip), ...accepted], only: list(values.only),
        }),
    });
    for (const { id, attempt } of pairs) console.log(`${id} ${attempt}`);
}
