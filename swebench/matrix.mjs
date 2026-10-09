// {§swebench-matrix}: profile scheduling only; run.sh owns each complete trial.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { jobsRoot, loadBenchmarkEnvironment } from "../src/host-paths.ts";
import { runToFiles } from "./run.ts";
import { readTrialRow, summarize, verdictOf } from "./report.ts";
import { corpusIds, planTrials } from "./plan.ts";
import { assertCleanSources } from "../src/source-provenance.ts";

const root = resolve(import.meta.dirname, "..");
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

export function planMatrix(profiles, attempts, instances) {
    if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("attempts must be a positive integer");
    if (!Array.isArray(instances) || !instances.length || instances.some((instance) => typeof instance !== "string" || !instance.trim())
        || new Set(instances).size !== instances.length) throw new Error("instances must be unique nonempty identifiers");
    if (!Array.isArray(profiles) || profiles.length === 0) throw new Error("profiles must be a nonempty array");
    const names = new Set();
    for (const profile of profiles) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.name) || names.has(profile.name)) throw new Error("profile names must be unique lowercase labels");
        names.add(profile.name);
        if (!profile.env || Array.isArray(profile.env) || typeof profile.env !== "object"
            || Object.entries(profile.env).some(([key, value]) => !/^PLURNK_[A-Za-z0-9_]+$/.test(key) || typeof value !== "string")) {
            throw new Error("profile env must contain PLURNK_* string values");
        }
    }
    return planTrials({ ids: instances, attempts, limit: 0, only: [], skip: [], done: new Set() })
        .flatMap(({ id, attempt }) => profiles.map((_, offset) => ({
            instance: id, profile: profiles[(offset + attempt - 1 + instances.indexOf(id)) % profiles.length].name, attempt,
        })));
}

export async function runMatrix({ profiles, instances, model, attempts, jobs, out, env, provenance, stopping = () => false }, execute = runToFiles, inspect = (trial, attempt) => ({
    verdict: verdictOf(trial), row: readTrialRow(trial, attempt),
})) {
    if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("jobs must be a positive integer");
    const trials = planMatrix(profiles, attempts, instances);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "plan.json"), JSON.stringify({ instances, model, profiles, attempts, jobs, provenance, trials }, null, 2) + "\n", { flag: "wx" });
    const pending = [...trials];
    const completed = [];
    let halted = false;
    const writeSummary = () => save(join(out, "summary.json"), {
        planned: trials.length, finished: completed.length, halted,
        profiles: profiles.map(({ name }) => {
            const records = completed.filter((record) => record.profile === name);
            const rows = records.flatMap(({ row }) => row ? [row] : []);
            const summary = summarize(rows);
            return { name, finished: records.length, missingEvidence: records.length - rows.length, ...summary,
                spend: { ...summary.spend, totalUsd: rows.length === records.length ? summary.spend.totalUsd : null },
            };
        }),
    });
    writeSummary();
    const run = async () => {
        while (!halted && !stopping() && pending.length) {
            const trial = pending.shift();
            const profile = profiles.find(({ name }) => name === trial.profile);
            const label = `${encodeURIComponent(trial.instance)}-${trial.profile}-${trial.attempt}`;
            const stdoutPath = join(out, `${label}.stdout.log`);
            const stderrPath = join(out, `${label}.stderr.log`);
            const startedAt = new Date().toISOString();
            appendFileSync(join(out, "launches.jsonl"), JSON.stringify({ ...trial, startedAt }) + "\n");
            console.log(`${startedAt} start ${label}`);
            let record;
            try {
                const execution = await execute(join(root, "swebench/run.sh"), ["--instance", trial.instance, "--model", model],
                    { cwd: root, env: { ...env, ...profile.env }, stdoutPath, stderrPath });
                const artifact = readFileSync(stdoutPath, "utf8").match(/^(?:artifact|ready)=(.+)$/m)?.[1] ?? null;
                const evidence = artifact ? inspect(artifact, trial.attempt) : { verdict: "harness: no trial directory", row: null };
                record = { ...trial, startedAt, artifact, exit: execution.status, ...evidence };
                if (!record.row || /^(agent|harness):/.test(record.verdict)) halted = true;
            } catch (error) {
                record = { ...trial, startedAt, artifact: null, exit: null, row: null, verdict: "harness: orchestration failed", error: String(error.stack ?? error) };
                halted = true;
            }
            record.finishedAt = new Date().toISOString();
            appendFileSync(join(out, "results.jsonl"), JSON.stringify(record) + "\n");
            completed.push(record);
            writeSummary();
            console.log(`${record.finishedAt} finish ${label} ${record.verdict}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, trials.length) }, run));
    if (halted || stopping()) throw new Error(`Matrix stopped launching; in-flight trials settled. See ${out}`);
    return completed;
}

if (import.meta.main) {
    const { values } = parseArgs({ options: {
        profiles: { type: "string" }, instance: { type: "string" }, corpus: { type: "string" }, model: { type: "string" },
        attempts: { type: "string" }, jobs: { type: "string" },
    } });
    if (!values.profiles || Boolean(values.instance) === Boolean(values.corpus) || !values.model || !values.attempts || !values.jobs) {
        throw new Error("usage: node swebench/matrix.mjs --profiles <json> (--instance <id> | --corpus <json>) --model <alias> --attempts <n> --jobs <n>");
    }
    loadBenchmarkEnvironment(undefined, join(root, ".env.defaults"));
    const profiles = JSON.parse(readFileSync(resolve(values.profiles), "utf8"));
    const instances = values.corpus ? corpusIds(JSON.parse(readFileSync(resolve(values.corpus), "utf8"))) : [values.instance];
    planMatrix(profiles, Number(values.attempts), instances);
    const serviceRoot = resolve(root, process.env.PLURNK_SWEBENCH_SERVICE_ROOT ?? "../plurnk-service");
    const clientRoot = resolve(root, process.env.PLURNK_SWEBENCH_CLIENT_ROOT ?? "../plurnk");
    const head = (cwd) => execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
    const profileSources = Object.fromEntries(profiles.map(({ name, env }) => [name, assertCleanSources({
        bench: root,
        service: resolve(root, env.PLURNK_SWEBENCH_SERVICE_ROOT ?? serviceRoot),
        client: resolve(root, env.PLURNK_SWEBENCH_CLIENT_ROOT ?? clientRoot),
    })]));
    const directory = jobsRoot("swebench-matrices");
    mkdirSync(directory, { recursive: true });
    const out = mkdtempSync(join(directory, `${values.instance ? encodeURIComponent(values.instance) : "corpus"}-${encodeURIComponent(values.model)}-`));
    let stopping = false;
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
    console.log(`matrix=${out}`);
    await runMatrix({ profiles, instances, model: values.model, attempts: Number(values.attempts),
        jobs: Number(values.jobs), out, stopping: () => stopping,
        env: { ...process.env, PLURNK_SWEBENCH_SERVICE_ROOT: serviceRoot, PLURNK_SWEBENCH_CLIENT_ROOT: clientRoot },
        provenance: { serviceRoot, serviceHead: head(serviceRoot), clientRoot, clientHead: head(clientRoot), benchHead: head(root), profileSources,
            ...(values.corpus ? { corpusPath: resolve(values.corpus), corpus: JSON.parse(readFileSync(resolve(values.corpus), "utf8")) } : {}),
        },
    });
}
