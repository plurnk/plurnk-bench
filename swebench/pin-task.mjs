// usage: node swebench/pin-task.mjs <instance>... — pin SWE-bench Lite instances from
// the official dataset into swebench/manifests/<instance>.json. The corpus and the
// evaluator venv are DOWNLOADED state under .cache/swebench, never repository source.
// Fail hard when an instance or the pinned interpreter is missing.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DATASET = "SWE-bench/SWE-bench_Lite";
const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");
const python = process.env.PLURNK_SWEBENCH_PYTHON ?? resolve(benchRoot, ".cache/swebench/venv/bin/python");

const instances = process.argv.slice(2);
if (instances.length === 0) throw new Error("usage: node swebench/pin-task.mjs <instance>...");
if (!existsSync(python)) throw new Error(`swebench venv python is missing: ${python} (see swebench/README.md)`);

const DUMP = `
import json, sys
from datasets import load_dataset
from huggingface_hub import HfApi
want = set(sys.argv[1:])
# {§swebench-corpus}: the ids and the dataset revision are pinned together.
revision = HfApi().dataset_info(${JSON.stringify(DATASET)}).sha
ds = load_dataset(${JSON.stringify(DATASET)}, split="test")
fields = ("instance_id","repo","base_commit","environment_setup_commit","version","image","problem_statement","FAIL_TO_PASS","PASS_TO_PASS")
found = {}
for r in ds:
    if r["instance_id"] in want:
        found[r["instance_id"]] = {k: r[k] for k in fields}
print(json.dumps({"found": found, "missing": sorted(want - set(found)), "revision": revision}))
`;

const out = execFileSync(python, ["-c", DUMP, ...instances], {
    encoding: "utf8",
    env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1" },
});
const { found, missing, revision } = JSON.parse(out);
if (missing.length > 0) throw new Error(`not in ${DATASET}: ${missing.join(", ")}`);

// The official dataset hands FAIL_TO_PASS/PASS_TO_PASS to `datasets` as Python
// lists (json.dumps emits arrays), while older revisions carry a JSON string.
const asTestList = (value) => Array.isArray(value) ? value : JSON.parse(value);

// A RUNAWAY GUARD, not a budget. The bound on an attempt is the study's 100-turn cap; the wall
// clock only catches a wedged container or a hung provider. 1800 s was invented here and bound
// first — a 19-turn rtx5070 rollout hit it and recorded a timeout, which measured our impatience,
// not the harness. Four hours is past any plausible 100-turn rollout on the slowest local route.
const BUDGET_SECONDS = Math.trunc(Number(process.env.PLURNK_SWEBENCH_BUDGET_SEC ?? 14400));
if (!(BUDGET_SECONDS > 0)) throw new Error("PLURNK_SWEBENCH_BUDGET_SEC must be a positive integer");
const TURN_CAP = Math.trunc(Number(process.env.PLURNK_SWEBENCH_TURN_CAP ?? 100));
if (!(TURN_CAP > 0)) throw new Error("PLURNK_SWEBENCH_TURN_CAP must be a positive integer");
const CPUS = Math.trunc(Number(process.env.PLURNK_SWEBENCH_CPUS ?? 4));
const MEMORY_MB = Math.trunc(Number(process.env.PLURNK_SWEBENCH_MEMORY_MB ?? 8192));
if (!(CPUS > 0) || !(MEMORY_MB > 0)) throw new Error("PLURNK_SWEBENCH_CPUS/MEMORY_MB must be positive integers");

const manifestsDir = resolve(moduleDir, "manifests");
mkdirSync(manifestsDir, { recursive: true });
for (const instance of instances) {
    const r = found[instance];
    const manifest = {
        schemaVersion: 1,
        harness: "swebench",
        dataset: DATASET,
        datasetRevision: revision,
        instance: r.instance_id,
        repo: r.repo,
        baseCommit: r.base_commit,
        environmentCommit: r.environment_setup_commit,
        version: r.version,
        environment: { kind: "docker", image: r.image, network: "none", cpus: CPUS, memoryMb: MEMORY_MB },
        budgetSeconds: BUDGET_SECONDS,
        turnCap: TURN_CAP,
        failToPass: asTestList(r.FAIL_TO_PASS),
        passToPass: asTestList(r.PASS_TO_PASS),
        problemStatement: r.problem_statement,
    };
    const manifestPath = resolve(manifestsDir, `${instance}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`pinned ${instance} -> ${manifestPath} (${r.repo} @ ${r.base_commit.slice(0, 12)}, ${manifest.failToPass.length} f2p, ${manifest.passToPass.length} p2p)`);
}
