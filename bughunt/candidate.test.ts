import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
    candidateArgv,
    captureBugsFound,
    capturePatch,
    exceptionInfo,
    extractPlurnkDoc,
    loadTaskPrompt,
    prepareRepository,
} from "./candidate.ts";

test("[§bughunt-prompts] prompts load verbatim task specifications", () => {
    const prompt1 = loadTaskPrompt("repo1");
    assert.match(prompt1, /VS Code \/ Cursor sidebar extension/);
    assert.match(prompt1, /BUGS_FOUND\.md/);
    assert.match(prompt1, /npx tsc -p \. --noEmit/);

    const prompt2 = loadTaskPrompt("repo2");
    assert.match(prompt2, /Vite\/React\/TypeScript application backed by Supabase Edge Functions/);
    assert.match(prompt2, /BUGS_FOUND\.md/);
    assert.match(prompt2, /npm run build/);

    assert.throws(() => loadTaskPrompt("unknown" as any), /Bug Hunt prompt not found/);
});

test("[§bughunt-candidate] candidate argv produces standard plurnk invocation", () => {
    const argv = candidateArgv("/workspace/repo", "Find bugs", {
        turnCap: 500,
        timeout: 1800,
        model: "deepdumb",
        effort: "low",
    });

    assert.deepEqual(argv, [
        "plurnk",
        "--json",
        "--yolo",
        "--max-turns", "500",
        "--project-root", "/workspace/repo",
        "--timeout", "1800",
        "--model", "deepdumb",
        "--effort", "low",
        "--", "Find bugs",
    ]);
});

test("[§bughunt-candidate] -1 timeout emits no --timeout flag and defaults apply", () => {
    const argv = candidateArgv("/workspace/repo", "Find bugs");
    assert.deepEqual(argv, [
        "plurnk",
        "--json",
        "--yolo",
        "--max-turns", "1000",
        "--project-root", "/workspace/repo",
        "--", "Find bugs",
    ]);
});

test("[§bughunt-trial] client --json document is recovered from candidate output", () => {
    const doc = JSON.stringify({ schemaVersion: 6, finalStatus: 200, turnCount: 42 });
    const log = ["Candidate started", doc, "Digest generation done", ""].join("\n");
    assert.equal(extractPlurnkDoc(log), doc);
    assert.equal(extractPlurnkDoc("plain output without json"), null);
    assert.equal(extractPlurnkDoc('{"missing":"schemaVersion"}\n'), null);
});

test("[§bughunt-trial] exception categorization identifies failure modes", () => {
    const clean = { status: 0, signal: null, timedOut: false };
    assert.equal(exceptionInfo(clean), null);

    const timedOut = exceptionInfo({ status: null, signal: "SIGTERM", timedOut: true }, 600);
    assert.equal(timedOut?.exception_type, "AgentTimeoutError");
    assert.match(timedOut?.exception_message ?? "", /600s/);

    const cancelled = exceptionInfo({
        status: null,
        signal: "SIGINT",
        timedOut: false,
        cancelled: true,
        error: new Error("operator stop"),
    });
    assert.equal(cancelled?.exception_type, "AgentCancelledError");
    assert.equal(cancelled?.exception_message, "operator stop");

    const spawnFailed = exceptionInfo({
        status: null,
        signal: null,
        timedOut: false,
        error: new Error("spawn ENOENT"),
    });
    assert.equal(spawnFailed?.exception_type, "AgentSpawnError");

    const nonZero = exceptionInfo({ status: 2, signal: null, timedOut: false });
    assert.equal(nonZero?.exception_type, "AgentExitError");
    assert.match(nonZero?.exception_message ?? "", /exited 2/);
});

test("[§bughunt-trial] prepareRepository, capturePatch, and captureBugsFound", (t) => {
    const root = mkdtempSync(join(tmpdir(), "bughunt-candidate-test-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const source = join(root, "source");
    const dest = join(root, "dest");
    const trial = join(root, "trial");

    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "file.txt"), "original content\n");

    const startHead = prepareRepository(source, dest);
    assert.ok(startHead.length >= 7, "startHead commit hash returned");

    // Modify a file and add BUGS_FOUND.md in dest
    writeFileSync(join(dest, "file.txt"), "modified content\n");
    writeFileSync(join(dest, "BUGS_FOUND.md"), "# Bugs Found\n1. Fixed null deref\n");

    const patchPath = capturePatch(dest, startHead, trial);
    assert.ok(existsSync(patchPath));
    const patchContent = readFileSync(patchPath, "utf8");
    assert.match(patchContent, /original content/);
    assert.match(patchContent, /modified content/);

    const capturedBugsFound = captureBugsFound(dest, trial);
    assert.ok(capturedBugsFound !== null && existsSync(capturedBugsFound));
    assert.match(readFileSync(capturedBugsFound, "utf8"), /Fixed null deref/);
});
