// Deterministic provider fixture, copied only into the integration-test bundle.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const evidence = "/logs/agent";
const requests = [];
const op = (header, body = "") => `\`\`\`\`${header}\n${body}\n\`\`\`\``;
const programs = [
    op("sh", "printf 'shell original\\n' > native.txt\npwd\npython -c 'import sys; print(sys.executable)'"),
    [op("READ (native.txt)"), op("READ (/testbed/native.txt)"),
        op("EDIT (/testbed/probe.js)", 'import { readFileSync } from "node:fs"; console.log("NODE_READ=" + readFileSync("/testbed/native.txt", "utf8").trim());')].join("\n"),
    op("EDIT (native.txt) <1,-1>", "native edited"),
    op("node (probe.js)"),
    op("KILL", "FIXTURE_COMPLETE"),
];
const tool = (id, name, args) => ({ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const piCalls = [
    tool("a", "bash", { command: "printf 'shell original\\n' > native.txt; pwd; python -c 'import sys; print(sys.executable)'" }),
    tool("b", "read", { path: "/testbed/native.txt" }),
    tool("c", "edit", { path: "native.txt", oldText: "shell original", newText: "native edited" }),
    tool("d", "bash", { command: 'node -e \'console.log("NODE_READ=" + require("node:fs").readFileSync("/testbed/native.txt", "utf8").trim())\'' }),
];
const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    requests.push(JSON.parse(body));
    writeFileSync(join(evidence, "fixture.requests.json"), JSON.stringify(requests, null, 2));
    if (process.env.FIXTURE_WAIT === "1") return;
    const index = requests.length - 1;
    const pi = process.argv[2] === "pi";
    const call = pi ? piCalls[index] : undefined;
    const content = pi ? (call ? undefined : "FIXTURE_COMPLETE") : programs[index];
    if (!content && !call) { response.writeHead(409); response.end("Unexpected extra turn"); return; }
    const chunk = (delta, finish_reason = null) => ({ id: `fixture-${index}`, object: "chat.completion.chunk",
        created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify(chunk({ role: "assistant", reasoning_content: "Perform the next fixture step." }))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk(call ? { tool_calls: [call] } : { content }))}\n\n`);
    response.end(`data: ${JSON.stringify({ ...chunk({}, call ? "tool_calls" : "stop"), usage: {
        prompt_tokens: 100, completion_tokens: 80, total_tokens: 180, prompt_tokens_details: { cached_tokens: 0 },
    } })}\n\ndata: [DONE]\n\n`);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
Object.assign(process.env, {
    PLURNK_MODEL: "fixture", PLURNK_MODEL_fixture: "fixture/fixture",
    PLURNK_PROVIDERS_PROVIDER_FIXTURE_NPM: "@ai-sdk/openai-compatible",
    PLURNK_PROVIDERS_PROVIDER_FIXTURE_BASE_URL: baseUrl,
    PLURNK_PROVIDERS_PROVIDER_FIXTURE_REASONING_BUDGET_PATH: "/reasoning/max_tokens",
    PLURNK_PROVIDERS_CONTEXT_WINDOW_fixture: "65536", PLURNK_PROVIDERS_OUTPUT_BUDGET_fixture: "4096",
    PLURNK_PROVIDERS_EFFORT_fixture: "adaptive", PLURNK_SERVICE_PROVIDER_RECOVERY: "0",
    PLURNK_EXECS_LUA: "1", PLURNK_SERVICE_FILES_ITEMS: "-1",
    PLURNK_SERVICE_POLICY: "", PLURNK_SERVICE_PACKET_INJECT: "", PLURNK_SERVICE_ROOTS: "project",
    OPENROUTER_API_KEY: "fixture-not-a-secret", PI_TELEMETRY: "0",
    PI_CODING_AGENT_DIR: join(evidence, "config"), PLURNK_PI_PROFILE: join(evidence, "profile.json"),
    PLURNK_PI_AGENT_DIR: evidence,
});
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
writeFileSync(join(evidence, "profile.json"), JSON.stringify({ turnCap: 6 }));
writeFileSync(join(process.env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: {
    openrouter: { baseUrl, api: "openai-completions", apiKey: "$OPENROUTER_API_KEY", models: [{ id: "fixture",
        reasoning: true, input: ["text"], contextWindow: 65536, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
} }));
try {
    if (process.env.FIXTURE_NETWORK === "1") {
        const allowed = await fetch("https://example.com", { signal: AbortSignal.timeout(10000) });
        await allowed.body?.cancel();
        await assert.rejects(fetch("https://example.org", { signal: AbortSignal.timeout(4000) }));
        writeFileSync(join(evidence, "network.json"), JSON.stringify({ allowed: allowed.status, denied: true }));
    } else await import("./production-runner.mjs");
    if (!process.env.FIXTURE_WAIT && !process.env.FIXTURE_NETWORK) {
        assert.equal(readFileSync("/testbed/native.txt", "utf8").trim(), "native edited");
        assert.match(JSON.stringify(requests), /NODE_READ=native edited/);
        assert.match(JSON.stringify(requests), /\/opt\/miniconda3\/envs\/testbed\/bin\/python/);
    }
} finally { server.closeAllConnections(); await new Promise((accept) => server.close(accept)); }
