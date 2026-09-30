// {§benchlet-isolation} — exactly the A2A definitions are masked; controls, companions, and MCP settings are untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { candidateIsolation } from "./candidate-isolation.ts";

test("[§benchlet-isolation] masks every A2A agent definition, blanks search keys, denies the web trait and the MCP and A2A families at the service ceiling, and admits no web host", () => {
    const { overrides, masked, capabilities } = candidateIsolation([
        "PLURNK_MCP_BRAVE_TOOLS", "PLURNK_MCP_EXPANDED", "PLURNK_MCP_CONNECT_TIMEOUT",
        "PLURNK_A2A_HELPER", "PLURNK_A2A_HELPER_BEARER", "PLURNK_A2A_EXPOSE", "PLURNK_A2A_TOKEN", "PLURNK_A2A_NAME",
        "PLURNK_A2A_WORKSPACE", "PLURNK_A2A_PROPOSALS", "PLURNK_A2A_SKILLS",
        "PLURNK_MODEL_dumbox", "DEEPSEEK_API_KEY", "PLURNK_A2A_HELPER",
    ]);
    assert.deepEqual(masked, ["PLURNK_A2A_HELPER"], "MCP servers come from plugins the candidate never reads, so no MCP variable is masked");
    assert.deepEqual(capabilities, { deny: [{ traits: ["web"] }, { operation: "mcp" }, { operation: "a2a" }] }, "the ceiling names the trait the web schemes declare and the two families it masks, never a host");
    assert.deepEqual(overrides, {
        PLURNK_A2A_HELPER: "",
        BRAVE_API_KEY: "", TAVILY_API_KEY: "",
        PLURNK_SERVICE_CAPABILITIES: "{\"deny\":[{\"traits\":[\"web\"]},{\"operation\":\"mcp\"},{\"operation\":\"a2a\"}]}",
        PLURNK_SCHEMES_HTTP_HOSTS: "[]",
    });
});
