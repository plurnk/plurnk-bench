// {§bughunt-evaluator} Bug Hunt Bench evaluation and reward translation.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { RewardJson } from "../src/ingest.ts";

export type BugHuntTargetTask = "repo1" | "repo2" | "all";

export interface BugHuntScore {
    readonly fixedOf105?: number;
    readonly fixedRepo1?: number;
    readonly fixedRepo2?: number;
    readonly partialFixes?: number;
    readonly claimedOnly?: number;
    readonly extras?: number;
    readonly brokenBuild?: boolean;
    readonly details?: string;
}

export interface BugHuntEvaluation {
    readonly task: BugHuntTargetTask;
    readonly model: string;
    readonly score: BugHuntScore;
    readonly reward: RewardJson;
    readonly gradedAt: string;
}

export const TARGET_BUGS_REPO1 = 45;
export const TARGET_BUGS_REPO2 = 60;
export const TARGET_BUGS_TOTAL = 105;

// {§bughunt-evaluator} Translate Bug Hunt scoring breakdown into platform RewardJson
export const translateScoreToReward = (
    score: BugHuntScore,
    task: BugHuntTargetTask,
): RewardJson => {
    let totalTarget: number;
    let fixed: number;

    switch (task) {
        case "repo1":
            totalTarget = TARGET_BUGS_REPO1;
            fixed = score.fixedRepo1 ?? score.fixedOf105 ?? 0;
            break;
        case "repo2":
            totalTarget = TARGET_BUGS_REPO2;
            fixed = score.fixedRepo2 ?? score.fixedOf105 ?? 0;
            break;
        case "all":
        default:
            totalTarget = TARGET_BUGS_TOTAL;
            fixed = score.fixedOf105 ?? ((score.fixedRepo1 ?? 0) + (score.fixedRepo2 ?? 0));
            break;
    }

    const partial = totalTarget > 0 ? Number((fixed / totalTarget).toFixed(4)) : 0;
    const isPassing = fixed >= totalTarget && !score.brokenBuild;

    return {
        reward: isPassing ? 1 : 0,
        f2p_total: totalTarget,
        f2p_passed: fixed,
        p2p_total: 1,
        p2p_passed: score.brokenBuild ? 0 : 1,
        partial,
        apply_failed: score.brokenBuild ? 1 : 0,
    };
};

// Write evaluation artifacts into trial directory
export const writeEvaluation = (trialDir: string, evaluation: BugHuntEvaluation): void => {
    const verifierDir = join(trialDir, "verifier");
    mkdirSync(verifierDir, { recursive: true });

    writeFileSync(
        join(verifierDir, "evaluation.json"),
        `${JSON.stringify(evaluation, null, 2)}\n`,
    );

    writeFileSync(
        join(verifierDir, "reward.json"),
        `${JSON.stringify(evaluation.reward, null, 2)}\n`,
    );
};

// Parse score input from JSON file or string
export const parseScoreJson = (content: string): BugHuntScore => {
    const raw = JSON.parse(content) as Record<string, unknown>;
    const score: BugHuntScore = {
        fixedOf105: typeof raw.fixedOf105 === "number" ? raw.fixedOf105 : (typeof raw.fixed_of_105 === "number" ? raw.fixed_of_105 : undefined),
        fixedRepo1: typeof raw.fixedRepo1 === "number" ? raw.fixedRepo1 : (typeof raw.fixed_of_45 === "number" ? raw.fixed_of_45 : undefined),
        fixedRepo2: typeof raw.fixedRepo2 === "number" ? raw.fixedRepo2 : (typeof raw.fixed_of_60 === "number" ? raw.fixed_of_60 : undefined),
        partialFixes: typeof raw.partialFixes === "number" ? raw.partialFixes : (typeof raw.partial === "number" ? raw.partial : undefined),
        claimedOnly: typeof raw.claimedOnly === "number" ? raw.claimedOnly : (typeof raw.claimed_only === "number" ? raw.claimed_only : undefined),
        extras: typeof raw.extras === "number" ? raw.extras : undefined,
        brokenBuild: typeof raw.brokenBuild === "boolean" ? raw.brokenBuild : (typeof raw.broken_build === "boolean" ? raw.broken_build : false),
        details: typeof raw.details === "string" ? raw.details : undefined,
    };
    return score;
};

// Verify repository health against prompt condition #2
export const verifyRepoHealth = (
    repository: string,
    task: "repo1" | "repo2",
): { healthy: boolean; details: string } => {
    const runCmd = (cmd: string, args: string[]): { ok: boolean; output: string } => {
        const result = spawnSync(cmd, args, { cwd: repository, encoding: "utf8" });
        return {
            ok: result.status === 0,
            output: (result.stderr || result.stdout || "").trim(),
        };
    };

    if (task === "repo1") {
        const tsc = runCmd("npx", ["tsc", "-p", ".", "--noEmit"]);
        if (!tsc.ok) return { healthy: false, details: `TypeScript check failed: ${tsc.output}` };

        const test = runCmd("npm", ["test"]);
        if (!test.ok) return { healthy: false, details: `npm test failed: ${test.output}` };

        return { healthy: true, details: "clean typecheck and passing tests" };
    } else {
        const test = runCmd("npm", ["test"]);
        if (!test.ok) return { healthy: false, details: `npm test failed: ${test.output}` };

        const build = runCmd("npm", ["run", "build"]);
        if (!build.ok) return { healthy: false, details: `npm run build failed: ${build.output}` };

        return { healthy: true, details: "clean build and passing tests" };
    }
};
