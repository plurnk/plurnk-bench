#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const arg = (key) => args[args.indexOf(key) + 1];
const instance = arg("-i");
const label = process.env.TEST_EVALUATOR_LABEL ?? "plurnk";
const scenario = process.env.TEST_EVALUATOR_SCENARIO;
const report = join(arg("--report_dir"), "logs", "run_evaluation", arg("-id"), label, instance, "report.json");
const instanceReport = { resolved: scenario !== "miss", patch_exists: true, patch_successfully_applied: true,
    infra_failure: scenario === "infrastructure", tests_status: {
        FAIL_TO_PASS: { success: scenario === "miss" ? [] : ["test_fix"], failure: scenario === "miss" ? ["test_fix"] : [] },
        PASS_TO_PASS: { success: ["test_old"], failure: [] },
    } };
if (scenario !== "missing") {
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, scenario === "malformed" ? "{" : JSON.stringify({
        [scenario === "wrong-instance" ? "another-instance" : instance]: scenario === "incomplete" ? {} : instanceReport,
    }));
}
console.log("instance evaluation finished");
if (scenario === "housekeeping" || scenario === "missing") {
    console.error("make_run_report: docker.errors.NotFound: 404 No such container");
    process.exitCode = 1;
}
