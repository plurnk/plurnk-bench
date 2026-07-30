import assert from "node:assert/strict";
import test from "node:test";
import {
    answerMatches,
    atlasClientArgs,
    requiemIsComplete,
    withoutMcpServers,
} from "./benchlet.ts";

test("Atlas answer evidence requires the expected whole answer token", () => {
    assert.equal(answerMatches("Customer", "Customer"), true);
    assert.equal(answerMatches("The answer is Customer.", "Customer"), true);
    assert.equal(answerMatches("CustomerService", "Customer"), false);
});

test("Atlas runs isolate their one MCP server without discarding model credentials", () => {
    assert.deepEqual(withoutMcpServers({
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
        PLURNK_MCP_GITHUB_HEADERS: "{\"Authorization\":\"secret\"}",
        PLURNK_MODEL_GROK: "xai/grok",
        XAI_API_KEY: "secret",
    }), {
        PLURNK_MODEL_GROK: "xai/grok",
        XAI_API_KEY: "secret",
    });
});

test("Atlas candidate is headless, Git-free, and retains the configured orientation survey", () => {
    assert.deepEqual(atlasClientArgs({
        filesItems: -1,
        maxTurns: 10,
        timeoutSeconds: 900,
        prompt: "task",
    }), [
        "--auto",
        "--project-root",
        "",
        "--no-git",
        "--files-items=-1",
        "--max-turns",
        "10",
        "--timeout",
        "900",
        "task",
    ]);
});

test("an enabled Atlas requiem is complete only with a successful call and both artifacts", () => {
    assert.equal(requiemIsComplete(0, true, true), true);
    assert.equal(requiemIsComplete(1, true, true), false);
    assert.equal(requiemIsComplete(0, false, true), false);
    assert.equal(requiemIsComplete(0, true, false), false);
});
