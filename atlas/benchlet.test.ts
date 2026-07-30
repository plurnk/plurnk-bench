import assert from "node:assert/strict";
import test from "node:test";
import {
    answerMatches,
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
