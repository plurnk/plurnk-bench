// SPEC §swebench-evaluator. Grade ONE instance's candidate patch with the benchmark's OWN
// official evaluator and translate its per-instance report into the `verifier/reward.json`
// the shared core joins (src/ingest.ts) — the verifier half of a trial. The harness owns
// grading end to end: it ensures the instance's eval image, resets the tree, applies the
// patch, runs the instance's own eval script, and writes reports. The bench supplies only
// the patch and translates the verdict; it never reimplements grading.
//
// usage: node swebench/evaluate.ts --instance <id> --patch <file|gold> --out <trialDir> \
//          [--label <name>] [--timeout <seconds>]

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
    emptyPatchReward,
    evaluationRunId,
    instanceReportPath,
    predictionsJsonl,
    rewardFromInstanceReport,
    type Prediction,
    type SweInstanceReport,
} from "./evaluator.ts";
import type { RewardJson } from "../src/ingest.ts";

const DATASET = "SWE-bench/SWE-bench_Lite";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");
const python = process.env.PLURNK_SWEBENCH_PYTHON ?? resolve(benchRoot, ".cache/swebench/venv/bin/python");

interface Manifest {
    readonly instance: string;
    readonly budgetSeconds: number;
}

const main = (): void => {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            instance: { type: "string" },
            patch: { type: "string" },
            out: { type: "string" },
            label: { type: "string" },
            timeout: { type: "string" },
        },
        allowPositionals: false,
        strict: true,
    });
    const instance = values.instance;
    const out = values.out;
    if (instance === undefined || out === undefined) {
        throw new Error("usage: node swebench/evaluate.ts --instance <id> --patch <file|gold> --out <trialDir> [--label <name>] [--timeout <seconds>]");
    }
    const manifestPath = resolve(moduleDir, "manifests", `${instance}.json`);
    if (!existsSync(manifestPath)) throw new Error(`no pinned manifest for ${instance}; run swebench/pin-task.mjs first`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    if (!existsSync(python)) throw new Error(`swebench venv python is missing: ${python} (see swebench/README.md)`);

    const gold = values.patch === undefined || values.patch === "gold";
    const label = values.label ?? (gold ? "gold" : "plurnk");
    const timeout = values.timeout === undefined ? manifest.budgetSeconds : Number(values.timeout);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("--timeout must be a positive integer");
    const runId = evaluationRunId(instance);

    const trialDir = resolve(out);
    const oracleDir = join(trialDir, "oracle");
    mkdirSync(oracleDir, { recursive: true });

    // A candidate patch becomes the harness's predictions file; `gold` grades the dataset's own
    // patch, the preflight that proves the oracle path without a model.
    let predictionsArg = "gold";
    const rewardPath = join(trialDir, "verifier", "reward.json");
    const writeReward = (reward: RewardJson): void => {
        mkdirSync(dirname(rewardPath), { recursive: true });
        writeFileSync(rewardPath, `${JSON.stringify(reward)}\n`);
    };
    if (!gold) {
        const patch = readFileSync(resolve(values.patch!), "utf8");
        // {§swebench-evaluator}: no patch is a scored zero, not a run of the harness.
        if (patch.trim().length === 0) {
            const reward = emptyPatchReward();
            writeReward(reward);
            console.log(JSON.stringify({ instance, label, reward, note: "the candidate produced no patch" }, null, 2));
            return;
        }
        const predictions: Prediction[] = [{ instance_id: instance, model_name_or_path: label, model_patch: patch }];
        predictionsArg = join(oracleDir, "predictions.jsonl");
        writeFileSync(predictionsArg, predictionsJsonl(predictions));
    }

    const result = spawnSync(python, [
        "-m", "swebench.harness.run_evaluation",
        "-d", DATASET, "-s", "test",
        "-i", instance,
        "-p", predictionsArg,
        "-id", runId,
        "--max_workers", "1",
        "-t", String(timeout),
        "--report_dir", oracleDir,
    ], {
        cwd: oracleDir,
        env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1" },
        stdio: "inherit",
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) throw new Error(`official evaluator exited ${result.status ?? result.signal ?? "unknown"}`);

    const reportPath = instanceReportPath(oracleDir, runId, label, instance);
    if (!existsSync(reportPath)) throw new Error(`the official evaluator wrote no per-instance report at ${reportPath}`);
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, SweInstanceReport>;
    const [instanceReport] = Object.values(report);
    const reward = rewardFromInstanceReport(instanceReport);
    if (reward === null) throw new Error(`no oracle verdict in ${reportPath} (infrastructure failure)`);

    writeReward(reward);
    console.log(JSON.stringify({ instance, label, runId, reportPath, rewardPath, reward }, null, 2));
};

main();
