import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    parseScoreJson,
    translateScoreToReward,
    writeEvaluation,
    type BugHuntEvaluation,
    type BugHuntScore,
} from "./evaluator.ts";
import { readTrial } from "../src/ingest.ts";

test("[§bughunt-evaluator] score translates to RewardJson across task scopes", () => {
    // Repo 1 leg
    const scoreRepo1: BugHuntScore = { fixedRepo1: 18 };
    const reward1 = translateScoreToReward(scoreRepo1, "repo1");
    assert.equal(reward1.reward, 0);
    assert.equal(reward1.f2p_total, 45);
    assert.equal(reward1.f2p_passed, 18);
    assert.equal(reward1.partial, 0.4);
    assert.equal(reward1.p2p_passed, 1);

    // Repo 2 leg
    const scoreRepo2: BugHuntScore = { fixedRepo2: 24 };
    const reward2 = translateScoreToReward(scoreRepo2, "repo2");
    assert.equal(reward2.reward, 0);
    assert.equal(reward2.f2p_total, 60);
    assert.equal(reward2.f2p_passed, 24);
    assert.equal(reward2.partial, 0.4);

    // Combined all (105 bugs)
    const scoreAll: BugHuntScore = { fixedOf105: 42 };
    const rewardAll = translateScoreToReward(scoreAll, "all");
    assert.equal(rewardAll.reward, 0);
    assert.equal(rewardAll.f2p_total, 105);
    assert.equal(rewardAll.f2p_passed, 42);
    assert.equal(rewardAll.partial, 0.4);

    // Perfect fix
    const perfect: BugHuntScore = { fixedOf105: 105 };
    assert.equal(translateScoreToReward(perfect, "all").reward, 1);

    // Broken build marks regression
    const broken: BugHuntScore = { fixedOf105: 42, brokenBuild: true };
    const rewardBroken = translateScoreToReward(broken, "all");
    assert.equal(rewardBroken.reward, 0);
    assert.equal(rewardBroken.p2p_passed, 0);
    assert.equal(rewardBroken.apply_failed, 1);
});

test("[§bughunt-evaluator] parseScoreJson handles standard runs.csv/json fields", () => {
    const jsonStr = JSON.stringify({
        fixed_of_105: 40,
        fixed_of_45: 18,
        fixed_of_60: 22,
        partial: 2,
        claimed_only: 1,
        broken_build: false,
    });
    const parsed = parseScoreJson(jsonStr);
    assert.equal(parsed.fixedOf105, 40);
    assert.equal(parsed.fixedRepo1, 18);
    assert.equal(parsed.fixedRepo2, 22);
    assert.equal(parsed.partialFixes, 2);
    assert.equal(parsed.claimedOnly, 1);
    assert.equal(parsed.brokenBuild, false);
});

test("[§bughunt-evaluator] writeEvaluation creates valid verifier artifacts that join cleanly", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bughunt-eval-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const trialDir = join(root, "trial");
    const agentDir = join(trialDir, "agent");
    mkdirSync(agentDir, { recursive: true });

    // Dummy plurnk doc and patch
    writeFileSync(
        join(agentDir, "plurnk.json"),
        JSON.stringify({ schemaVersion: 6, finalStatus: 200, wallMs: 12000, turnCount: 20 }) + "\n",
    );

    const score: BugHuntScore = { fixedOf105: 35, fixedRepo1: 15, fixedRepo2: 20 };
    const evaluation: BugHuntEvaluation = {
        task: "all",
        model: "deepdumb",
        score,
        reward: translateScoreToReward(score, "all"),
        gradedAt: new Date().toISOString(),
    };

    writeEvaluation(trialDir, evaluation);

    assert.ok(existsSync(join(trialDir, "verifier", "evaluation.json")));
    assert.ok(existsSync(join(trialDir, "verifier", "reward.json")));

    // Verify joinRecord ingestion
    const record = readTrial(trialDir, { harness: "bughunt", taskId: "all", model: "deepdumb" });
    assert.equal(record.harness, "bughunt");
    assert.equal(record.taskId, "all");
    assert.equal(record.model, "deepdumb");
    assert.equal(record.status, 200);
    assert.equal(record.outcome, "fail"); // reward < 1
    assert.equal(record.testPassFraction, 0.3333);
});
