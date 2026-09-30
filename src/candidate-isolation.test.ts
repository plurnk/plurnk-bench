// {§benchlet-isolation}
import test from "node:test";
import assert from "node:assert/strict";
import { candidateIsolation } from "./candidate-isolation.ts";

test("[§benchlet-isolation] disables ambient endpoint and skill aliases without blanking definitions, and retains independent network ceilings", () => {
    const { overrides, masked, capabilities } = candidateIsolation([
        "PLURNK_MCP_brave_TOOLS", "PLURNK_MCP_EXPANDED", "PLURNK_MCP_CONNECT_TIMEOUT",
        "PLURNK_MCP_code_search", "PLURNK_MCP_code_search_ENABLED",
        "PLURNK_A2A_helper", "PLURNK_A2A_helper_ENABLED", "PLURNK_A2A_EXPOSE", "PLURNK_A2A_TOKEN", "PLURNK_A2A_NAME",
        "PLURNK_A2A_WORKSPACE", "PLURNK_A2A_PROPOSALS", "PLURNK_A2A_SKILLS",
        "PLURNK_MODEL_dumbox", "DEEPSEEK_API_KEY", "PLURNK_A2A_helper",
        "PLURNK_SKILLS_3d_tools", "PLURNK_SKILLS_分析", "PLURNK_SKILLS_分析_ENABLED", "PLURNK_SKILLS_ENABLED",
    ]);
    assert.deepEqual(masked, ["PLURNK_A2A_helper", "PLURNK_MCP_brave", "PLURNK_MCP_code_search", "PLURNK_SKILLS_3d_tools", "PLURNK_SKILLS_分析"]);
    assert.deepEqual(capabilities, { deny: [{ traits: ["web"] }, { operation: "mcp" }, { operation: "a2a" }] }, "the ceiling names the trait the web schemes declare and the two families it masks, never a host");
    assert.deepEqual(overrides, {
        PLURNK_MCP_ENABLED: "0", PLURNK_A2A_ENABLED: "0",
        PLURNK_A2A_helper_ENABLED: "0", PLURNK_MCP_brave_ENABLED: "0", PLURNK_MCP_code_search_ENABLED: "0",
        PLURNK_SKILLS_3d_tools_ENABLED: "0", PLURNK_SKILLS_分析_ENABLED: "0",
        BRAVE_API_KEY: "", TAVILY_API_KEY: "",
        PLURNK_SERVICE_CAPABILITIES: "{\"deny\":[{\"traits\":[\"web\"]},{\"operation\":\"mcp\"},{\"operation\":\"a2a\"}]}",
        PLURNK_SCHEMES_HTTP_HOSTS: "[]",
    });
});
