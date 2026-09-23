// {§swebench-profiles} — the (instance, attempt) pairs one campaign launch runs, in corpus order:
// --only and --skip narrow the corpus, a resumed campaign drops every pair its trials.tsv already
// records as a clean pass, and --limit bounds what this launch runs. Sequential by construction:
// campaign.sh consumes the list one pair at a time.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export interface PlannedTrial { readonly id: string; readonly attempt: number }

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

// A corpus is a list of ids, or an object carrying one under `ids`, `instances`, `tasks` or any key.
export const corpusIds = (corpus: unknown): string[] => {
    if (strings(corpus)) return corpus;
    const record = corpus as Record<string, unknown>;
    const found = [record.ids, record.instances, record.tasks, ...Object.values(record)].find(strings);
    if (found === undefined) throw new Error("corpus carries no ids");
    return found;
};

// trials.tsv columns: instance, attempt, rc, trial, published, verdict. Only a clean pass is done;
// a halted trial runs again on resume unless its id is skipped.
export const passedPairs = (trialsTsv: string): Set<string> => new Set(
    trialsTsv.split("\n").filter((line) => line.trim() !== "").map((line) => line.split("\t"))
        .filter((cells) => cells[5] === "pass").map((cells) => `${cells[0]}\t${cells[1]}`),
);

export const planTrials = (input: {
    readonly ids: readonly string[]; readonly attempts: number; readonly limit: number;
    readonly only: readonly string[]; readonly skip: readonly string[]; readonly passed: ReadonlySet<string>;
}): PlannedTrial[] => {
    const only = new Set(input.only);
    const skip = new Set(input.skip);
    const chosen = input.ids.filter((id) => (only.size === 0 || only.has(id)) && !skip.has(id));
    const pairs = Array.from({ length: input.attempts }, (_, index) => index + 1)
        .flatMap((attempt) => chosen.map((id) => ({ id, attempt })))
        .filter(({ id, attempt }) => !input.passed.has(`${id}\t${attempt}`));
    return input.limit > 0 ? pairs.slice(0, input.limit) : pairs;
};

if (import.meta.main) {
    const { values } = parseArgs({ options: {
        corpus: { type: "string" }, attempts: { type: "string", default: "1" }, limit: { type: "string", default: "0" },
        only: { type: "string", default: "" }, skip: { type: "string", default: "" }, trials: { type: "string" },
    } });
    if (values.corpus === undefined) throw new Error("usage: swebench/plan.ts --corpus <file> [--attempts N] [--limit N] [--only id,id] [--skip id,id] [--trials trials.tsv]");
    const list = (value: string): string[] => value.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const pairs = planTrials({
        ids: corpusIds(JSON.parse(readFileSync(values.corpus, "utf8"))),
        attempts: Number(values.attempts), limit: Number(values.limit), only: list(values.only), skip: list(values.skip),
        passed: values.trials === undefined ? new Set() : passedPairs(readFileSync(values.trials, "utf8")),
    });
    for (const { id, attempt } of pairs) console.log(`${id} ${attempt}`);
}
