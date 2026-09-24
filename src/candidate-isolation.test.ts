// {§benchlet-isolation} — exactly the definitions are masked; controls and companions are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { candidateIsolation } from "./candidate-isolation.ts";

test("[§benchlet-isolation] masks every MCP server and A2A agent definition, blanks search keys, denies the web trait and the masked families at the service ceiling, and admits no web host", () => {
    const { overrides, masked, capabilities } = candidateIsolation([
        "PLURNK_MCP_BRAVE", "PLURNK_MCP_BRAVE_ARGS", "PLURNK_MCP_BRAVE_ENV", "PLURNK_MCP_BRAVE_READ",
        "PLURNK_MCP_CDP", "PLURNK_MCP_ENABLED", "PLURNK_MCP_EXPANDED", "PLURNK_MCP_CONNECT_TIMEOUT",
        "PLURNK_MCP_GITEA", "PLURNK_MCP_GH",
        "PLURNK_A2A_HELPER", "PLURNK_A2A_HELPER_BEARER", "PLURNK_A2A_EXPOSE", "PLURNK_A2A_PORT", "PLURNK_A2A_HOST",
        "PLURNK_MODEL_dumbox", "DEEPSEEK_API_KEY", "PLURNK_MCP_BRAVE",
    ]);
    assert.deepEqual(masked, ["PLURNK_A2A_HELPER", "PLURNK_MCP_BRAVE", "PLURNK_MCP_CDP", "PLURNK_MCP_GH", "PLURNK_MCP_GITEA"]);
    assert.deepEqual(capabilities, { deny: [{ traits: ["web"] }, { operation: "mcp" }, { operation: "a2a" }] }, "the ceiling names the trait the web schemes declare and the two families it masks, never a host");
    assert.deepEqual(overrides, {
        PLURNK_A2A_HELPER: "", PLURNK_MCP_BRAVE: "", PLURNK_MCP_CDP: "", PLURNK_MCP_GH: "", PLURNK_MCP_GITEA: "",
        BRAVE_API_KEY: "", TAVILY_API_KEY: "",
        PLURNK_SERVICE_CAPABILITIES: "{\"deny\":[{\"traits\":[\"web\"]},{\"operation\":\"mcp\"},{\"operation\":\"a2a\"}]}",
        PLURNK_SCHEMES_HTTP_HOSTS: "[]",
    });
});
