import assert from "node:assert/strict";
import { after, test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainCaptures, observeFetch } from "./pi-observer.mjs";
import { piArguments, piConfiguration, piLaunch, summarizePi, validateProfile, providerDefinition, selectedModel } from "./pi.mjs";
import { runToFiles } from "./run.ts";
import { runCampaign } from "./pi-campaign.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-comparison-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
const rates = { input: 0.15, cacheRead: 0.03, cacheWrite: 0, output: 0.5 };
const usage = { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35,
    prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 4 },
    cost: 0.001, is_byok: true, cost_details: { upstream_inference_cost: 0.002 } };

test("{§swebench-pi} wire observation preserves streaming content and authoritative BYOK billing", async () => {
    const agent = mkdtempSync(join(root, "billing-"));
    const wire = join(agent, "wire");
    const raw = `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
    const fetch = observeFetch(async () => new Response(raw, { headers: { "content-type": "text/event-stream" } }), wire);
    const response = await fetch("https://example.invalid/v1/chat/completions", { body: '{"model":"example"}' });
    assert.equal(await response.text(), raw);
    await drainCaptures();
    assert.equal(readFileSync(join(wire, "0001.response.txt"), "utf8"), raw);
    writeFileSync(join(agent, "pi.stdout.jsonl"), "");
    const summary = summarizePi(agent, rates);
    assert.equal(summary.chargedUsd, 0.003);
    assert.equal(summary.unpricedRequests, 0);
    assert.equal(summary.responsesWithReasoningBreakdown, 1);
    assert.deepEqual(summary.usage, { input: 20, cacheRead: 5, cacheWrite: 0, output: 10, reasoning: 4 });
    assert.equal(summary.repricedUsd, 0.00000815);
    writeFileSync(join(wire, "0001.response.txt"), raw.replace(',"upstream_inference_cost":0.002', '').replace('"upstream_inference_cost":0.002', ''));
    assert.equal(summarizePi(agent, rates).unpricedRequests, 1);
    assert.equal(summarizePi(agent, rates).chargedUsd, null);
    assert.equal(summarizePi(agent, rates).knownChargedUsd, null);
});

test("{§swebench-pi} absent and interrupted responses remain explicitly unpriced", () => {
    const agent = mkdtempSync(join(root, "missing-"));
    writeFileSync(join(agent, "pi.stdout.jsonl"), "");
    assert.equal(summarizePi(agent, rates).requests, 0);
    mkdirSync(join(agent, "wire"));
    json(join(agent, "wire/0001.request.json"), { model: "example" });
    writeFileSync(join(agent, "wire/0001.response.txt"), 'data: {"usage":');
    const summary = summarizePi(agent, rates);
    assert.equal(summary.unpricedRequests, 1);
    assert.equal(summary.responsesWithUsage, 0);
    assert.equal(summary.chargedUsd, null);
    assert.equal(summary.knownChargedUsd, null);
    assert.equal(summary.repricedUsd, null);
    assert.equal(summary.knownRepricedUsd, null);
    assert.deepEqual(summary.usage, { input: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null });
    assert.match(summary.failures[0].error, /Incomplete provider frame/);
});

test("{§swebench-pi} a successful retry cannot erase the missing accounting of its failed request", () => {
    const agent = mkdtempSync(join(root, "partial-"));
    mkdirSync(join(agent, "wire"));
    writeFileSync(join(agent, "pi.stdout.jsonl"), "");
    for (const id of ["0001", "0002"]) {
        json(join(agent, `wire/${id}.request.json`), { model: "example" });
        json(join(agent, `wire/${id}.http.json`), { status: 200 });
    }
    const failed = 'data: {"choices":[{"delta":{"reasoning_content":"Partial thought"}}]}\n\n';
    writeFileSync(join(agent, "wire/0001.response.txt"), failed);
    writeFileSync(join(agent, "wire/0002.response.txt"), `data: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`);
    const summary = summarizePi(agent, rates);
    assert.equal(summary.requests, 2);
    assert.equal(summary.responsesWithUsage, 1);
    assert.equal(summary.chargedUsd, null);
    assert.equal(summary.knownChargedUsd, 0.003);
    assert.equal(summary.repricedUsd, null);
    assert.equal(summary.knownRepricedUsd, 0.00000815);
    assert.equal(summary.usage.output, null);
    assert.deepEqual(summary.knownUsage, { input: 20, cacheRead: 5, cacheWrite: 0, output: 10, reasoning: 4 });
    assert.equal(readFileSync(join(agent, "wire/0001.response.txt"), "utf8"), failed);
});

test("{§swebench-pi} a reported charge survives missing token usage", () => {
    const agent = mkdtempSync(join(root, "charge-only-"));
    mkdirSync(join(agent, "wire"));
    writeFileSync(join(agent, "pi.stdout.jsonl"), "");
    json(join(agent, "wire/0001.request.json"), { model: "example" });
    json(join(agent, "wire/0001.http.json"), { status: 200 });
    writeFileSync(join(agent, "wire/0001.response.txt"), 'data: {"usage":{"cost":0.02,"is_byok":false}}\n\n');
    const summary = summarizePi(agent, rates);
    assert.equal(summary.chargedUsd, 0.02);
    assert.equal(summary.knownChargedUsd, 0.02);
    assert.equal(summary.repricedUsd, null);
    assert.equal(summary.responsesWithUsage, 0);
});

test("{§swebench-pi} campaign summaries preserve incomplete trial costs, including historical captures", async () => {
    const dir = mkdtempSync(join(root, "campaign-partial-"));
    const corpus = join(dir, "corpus.json");
    const profile = join(dir, "profile.json");
    const out = join(dir, "campaign");
    json(corpus, ["a", "b"]);
    json(profile, {});
    let calls = 0;
    await runCampaign({ corpus, profile, out, attempts: 1, jobs: 1 }, async (_command, _args, { stdoutPath }) => {
        const artifact = join(dir, `trial-${++calls}`);
        mkdirSync(join(artifact, "agent"), { recursive: true });
        mkdirSync(join(artifact, "verifier"));
        writeFileSync(stdoutPath, `artifact=${artifact}\n`);
        json(join(artifact, "agent/summary.json"), calls === 1
            ? { requests: 2, chargedUsd: null, knownChargedUsd: 0.01, unpricedRequests: 1,
                repricedUsd: null, knownRepricedUsd: 0.02, responsesWithTokenBreakdown: 1, errors: [], failures: [] }
            : { requests: 1, chargedUsd: 0, unpricedRequests: 1, repricedUsd: 0.03,
                responsesWithTokenBreakdown: 1, errors: [], failures: [] });
        json(join(artifact, "verifier/reward.json"), { reward: 1 });
        json(join(artifact, "result.json"), { exception_info: null });
        return { status: 0 };
    });
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    assert.equal(summary.finished, 2);
    assert.equal(summary.chargedUsd, null);
    assert.equal(summary.knownChargedUsd, 0.01);
    assert.equal(summary.repricedUsd, null);
    assert.equal(summary.knownRepricedUsd, 0.05);
});

test("{§swebench-pi} Messages capture preserves bytes and merges final cumulative usage without double counting", async () => {
    const agent = mkdtempSync(join(root, "messages-"));
    const wire = join(agent, "wire");
    const frames = [
        { type: "message_start", message: { usage: { input_tokens: 20, output_tokens: 1,
            cache_read_input_tokens: 5, cache_creation_input_tokens: 3 } } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Inspect the file." } },
        { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 7 } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 22, output_tokens: 10 } },
        { type: "message_stop" },
    ];
    const raw = frames.map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
    const request = '{"model":"example","output_config":{"effort":"xhigh"}}';
    const fetch = observeFetch(async (_url, init) => {
        assert.equal(init.body, request);
        return new Response(raw, { headers: { "content-type": "text/event-stream" } });
    }, wire);
    assert.equal(await (await fetch("https://example.invalid/v1/messages", { body: request })).text(), raw);
    await drainCaptures();
    assert.equal(readFileSync(join(wire, "0001.request.json"), "utf8"), request + "\n");
    assert.equal(readFileSync(join(wire, "0001.response.txt"), "utf8"), raw);
    writeFileSync(join(agent, "pi.stdout.jsonl"), "");
    const summary = summarizePi(agent, { input: 2, cacheRead: 0.25, cacheWrite: 2, output: 6 });
    assert.equal(summary.requests, 1);
    assert.equal(summary.responsesWithUsage, 1);
    assert.equal(summary.responsesWithTokenBreakdown, 1);
    assert.equal(summary.responsesWithReasoningBreakdown, 0);
    assert.deepEqual(summary.usage, { input: 22, cacheRead: 5, cacheWrite: 3, output: 10, reasoning: null });
    assert.equal(summary.repricedUsd, 0.00011125);
    assert.equal(summary.chargedUsd, null);
    assert.equal(summary.unpricedRequests, 1);
    assert.deepEqual(summary.failures, []);
});

test("{§swebench-pi} unfinished Messages usage is not reported as a fully priced response", () => {
    const agent = mkdtempSync(join(root, "messages-incomplete-"));
    mkdirSync(join(agent, "wire"));
    writeFileSync(join(agent, "pi.stdout.jsonl"), "");
    json(join(agent, "wire/0001.request.json"), { model: "example" });
    json(join(agent, "wire/0001.http.json"), { status: 200 });
    writeFileSync(join(agent, "wire/0001.response.txt"), `data: ${JSON.stringify({ type: "message_start",
        message: { usage: { input_tokens: 20, output_tokens: 1 } } })}\n\n`);
    const summary = summarizePi(agent, rates);
    assert.equal(summary.requests, 1);
    assert.equal(summary.responsesWithUsage, 0);
    assert.equal(summary.responsesWithTokenBreakdown, 0);
    assert.equal(summary.unpricedRequests, 1);
});

test("{§swebench-pi} profiles require explicit route, version, limits and rates", () => {
    assert.throws(() => validateProfile({}), /openrouter, deepseek and fireworks/);
    assert.throws(() => validateProfile({ provider: "local", baseUrl: "https://model.example/v1" }), /api openai-completions or anthropic-messages/, "a baseUrl provider names its api");
    const local = { provider: "local", baseUrl: "https://model.example/v1", api: "openai-completions", contextWindow: 86016, maxOutputTokens: 24576,
        executable: "pi", version: "fixture", model: "fixture", catalogPath: "/dev/null", effort: "medium", turnCap: 100, timeoutSeconds: 30,
        rates: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
    assert.equal(validateProfile(local), local, "{§swebench-pi} any OpenAI-compatible endpoint is a provider path: a local llama-server among them");
    assert.deepEqual(providerDefinition(local, "PLURNK_PI_LOCAL_KEY"), { providers: { local: { baseUrl: local.baseUrl, api: "openai-completions", apiKey: "$PLURNK_PI_LOCAL_KEY",
        models: [{ id: "fixture", reasoning: true, input: ["text"], contextWindow: 86016, maxTokens: 24576, cost: local.rates }] } } }, "the comparator writes Pi's own provider definition");
    assert.throws(() => validateProfile({ provider: "openrouter" }), /executable/);
    const profile = { provider: "fireworks", executable: "pi", version: "fixture", model: "fixture",
        catalogPath: "catalog.json", effort: "medium", turnCap: 100, timeoutSeconds: 14400, rates };
    assert.equal(validateProfile(profile), profile);
    assert.deepEqual(selectedModel(local, {}, "PLURNK_PI_LOCAL_KEY"), providerDefinition(local, "PLURNK_PI_LOCAL_KEY").providers.local.models[0],
        "a baseUrl provider's model is the profile's own definition; the frozen catalog never carries it");
    assert.equal(selectedModel(profile, { fireworks: { models: [{ id: "fixture", name: "Fixture" }] } }, "FIREWORKS_API_KEY").name, "Fixture", "a hosted model is its catalog entry");
    assert.throws(() => selectedModel(profile, {}, "FIREWORKS_API_KEY"), /frozen catalog/, "a hosted model absent from the frozen catalog is refused");
});

test("{§swebench-pi} campaigns bound concurrency, retain losses and resume without rebuying attempts", async () => {
    const dir = mkdtempSync(join(root, "campaign-"));
    const corpus = join(dir, "corpus.json");
    const profile = join(dir, "profile.json");
    json(corpus, ["a", "b", "c"]);
    json(profile, { effort: "low" });
    const options = { corpus, profile, out: join(dir, "campaign"), attempts: 3, jobs: 2 };
    let calls = 0;
    let active = 0;
    let peak = 0;
    const execute = async (_command, _args, { stdoutPath }) => {
        const artifact = join(dir, `trial-${++calls}`);
        active++;
        peak = Math.max(active, peak);
        await new Promise((resolve) => setTimeout(resolve, 5));
        mkdirSync(join(artifact, "agent"), { recursive: true });
        mkdirSync(join(artifact, "verifier"));
        writeFileSync(stdoutPath, `artifact=${artifact}\n`);
        json(join(artifact, "agent/summary.json"), { requests: 1, chargedUsd: 0.01, unpricedRequests: 0, errors: [], failures: [] });
        json(join(artifact, "verifier/reward.json"), { reward: calls % 2 });
        json(join(artifact, "result.json"), { exception_info: null });
        active--;
        return { status: 0 };
    };
    await runCampaign(options, execute);
    assert.equal(peak, 2);
    assert.equal(calls, 9);
    const completed = JSON.parse(readFileSync(join(options.out, "summary.json"), "utf8"));
    assert.equal(completed.finished, 9);
    assert.ok(completed.passes > 0 && completed.passes < 9);
    await runCampaign(options, execute);
    assert.equal(calls, 9);
    json(profile, { effort: "high" });
    await assert.rejects(runCampaign(options, execute), /configuration changed/);
});

test("{§swebench-pi} a setup failure pauses new work without discarding the failed attempt", async () => {
    const dir = mkdtempSync(join(root, "pause-"));
    const corpus = join(dir, "corpus.json");
    const profile = join(dir, "profile.json");
    json(corpus, ["a", "b", "c"]);
    json(profile, {});
    const options = { corpus, profile, out: join(dir, "campaign"), attempts: 3, jobs: 1 };
    let calls = 0;
    await assert.rejects(runCampaign(options, async (_command, _args, { stdoutPath }) => {
        calls++;
        writeFileSync(stdoutPath, "failed before creating a trial\n");
        return { status: 1 };
    }), /paused for review/);
    assert.equal(calls, 1);
    const completed = JSON.parse(readFileSync(join(options.out, "results.jsonl"), "utf8"));
    assert.equal(completed.exit, 1);
    assert.equal(completed.reward, null);
    assert.equal(completed.pause, true);
    // The paused pair is the one under review: a resume runs it again, and the record keeps one result per pair.
    let resumed = 0;
    await runCampaign(options, async (_command, _args, { stdoutPath }) => {
        const artifact = join(dir, `trial-${++resumed}`);
        mkdirSync(join(artifact, "agent"), { recursive: true });
        mkdirSync(join(artifact, "verifier"));
        writeFileSync(stdoutPath, `artifact=${artifact}\n`);
        json(join(artifact, "agent/summary.json"), { requests: 1, chargedUsd: 0.01, unpricedRequests: 0, errors: [], failures: [] });
        json(join(artifact, "verifier/reward.json"), { reward: 1 });
        json(join(artifact, "result.json"), { exception_info: null });
        return { status: 0 };
    });
    assert.equal(resumed, 9, "the paused pair and the eight never-run pairs");
    const rows = readFileSync(join(options.out, "results.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.length, 10, "results.jsonl is append-only: the paused row stays as history");
    const summary = JSON.parse(readFileSync(join(options.out, "summary.json"), "utf8"));
    assert.deepEqual({ finished: summary.finished, passes: summary.passes, paused: summary.paused }, { finished: 9, passes: 9, paused: [] });
});

for (const { name, limits, errors, failures = [], exception = null, pause } of [
    { name: "recorded turn-cap abort", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "This operation was aborted" }], pause: false },
    { name: "unexplained abort", limits: [],
        errors: [{ stopReason: "error", error: "This operation was aborted" }], pause: false },
    { name: "provider failure despite a cap", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "HTTP 503: unavailable" }], pause: false },
    { name: "earlier provider failure before a cap", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "HTTP 503: unavailable" },
            { stopReason: "error", error: "This operation was aborted" }], pause: false },
    { name: "native stream truncation", limits: [],
        errors: [{ stopReason: "error", error: "Anthropic stream ended before message_stop" }], pause: false },
    { name: "nonzero agent exit", limits: [], errors: [],
        exception: { exception_type: "AgentExitError", exception_message: "the client exited 1" }, pause: false },
    { name: "agent time limit", limits: [], errors: [],
        exception: { exception_type: "AgentTimeoutError", exception_message: "the client exceeded its limit" }, pause: false },
    { name: "agent spawn failure", limits: [], errors: [],
        exception: { exception_type: "AgentSpawnError", exception_message: "spawn failed" }, pause: true },
    { name: "capture failure despite a cap", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "This operation was aborted" }],
        failures: [{ error: "Response capture interrupted" }], pause: false },
]) {
    test(`{§swebench-pi} campaign distinguishes ${name} without discarding evidence`, async () => {
        const dir = mkdtempSync(join(root, "stops-"));
        const corpus = join(dir, "corpus.json");
        const profile = join(dir, "profile.json");
        json(corpus, ["a", "b"]);
        json(profile, { turnCap: 100 });
        const options = { corpus, profile, out: join(dir, "campaign"), attempts: 1, jobs: 1 };
        let calls = 0;
        const execute = async (_command, _args, { stdoutPath }) => {
            const artifact = join(dir, `trial-${++calls}`);
            mkdirSync(join(artifact, "agent"), { recursive: true });
            mkdirSync(join(artifact, "verifier"));
            writeFileSync(stdoutPath, `artifact=${artifact}\n`);
            json(join(artifact, "agent/summary.json"), { requests: 100, chargedUsd: 0.1, unpricedRequests: 0,
                errors, failures, limits });
            json(join(artifact, "verifier/reward.json"), { reward: 0 });
            json(join(artifact, "result.json"), { exception_info: exception });
            return { status: 0 };
        };
        if (pause) await assert.rejects(runCampaign(options, execute), /paused for review/);
        else await runCampaign(options, execute);
        assert.equal(calls, pause ? 1 : 2);
        const results = readFileSync(join(options.out, "results.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(results[0].pause, pause);
        assert.deepEqual(results[0].summary.errors, errors);
        assert.deepEqual(results[0].summary.limits, limits);
        assert.deepEqual(results[0].exception, exception);
        assert.equal(results[0].reward.reward, 0);
        if (!pause) {
            await runCampaign(options, execute);
            assert.equal(calls, 2);
        }
    });
}

for (const { provider, api, effort, credential } of [
    { provider: "openrouter", api: "openai-completions", effort: "low", credential: "OPENROUTER_API_KEY" },
    { provider: "fireworks", api: "openai-completions", effort: "medium", credential: "FIREWORKS_API_KEY" },
    { provider: "fireworks", api: "anthropic-messages", effort: "xhigh", credential: "FIREWORKS_API_KEY" },
    { provider: "local", api: "openai-completions", effort: "medium", credential: "PLURNK_PI_LOCAL_KEY" },
]) for (const turnCap of [1, 100]) {
    test(`{§swebench-pi} installed native Pi ${provider}/${api}: isolated context, tools, wire effort and ${turnCap}-turn bound`, {
        skip: !process.env.PLURNK_BENCH_PI, timeout: 60000,
    }, async () => {
        const agent = mkdtempSync(join(root, "native-"));
        const repo = join(agent, "repo");
        const configDir = join(agent, "config");
        mkdirSync(repo);
        mkdirSync(configDir);
        writeFileSync(join(repo, "AGENTS.md"), "FORBIDDEN_PERSONAL_CONTEXT_MARKER");
        const shellPath = join(agent, "bash");
        writeFileSync(shellPath, '#!/bin/sh\nprintf "NATIVE_SHELL_PATH_USED\\n"\nexec /bin/bash "$@"\n', { mode: 0o755 });
        writeFileSync(join(agent, "node"), '#!/bin/sh\necho "HOST_RUNTIME_ENTERED_CONTAINER_SHIM" >&2\nexit 77\n', { mode: 0o755 });
        const requests = [];
        const server = createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += chunk;
            requests.push(JSON.parse(body));
            const tools = [{ index: 0, id: "shell1", type: "function", function: { name: "bash", arguments: '{"command":"printf shell-tested"}' } },
                { index: 1, id: "write1", type: "function", function: { name: "write", arguments: '{"path":"native.txt","content":"native write"}' } }];
            const first = requests.length === 1;
            const { cost: _cost, is_byok: _byok, cost_details: _details, ...tokenUsage } = usage;
            const frame = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
                choices: [{ index: 0, delta: { role: "assistant", ...(first ? { tool_calls: tools } : { content: "Verified." }) }, finish_reason: first ? "tool_calls" : "stop" }],
                usage: provider === "fireworks" ? tokenUsage : usage };
            response.writeHead(200, { "content-type": "text/event-stream" });
            if (api === "anthropic-messages") {
                const blocks = first ? tools.flatMap((tool) => [
                    { type: "content_block_start", index: tool.index, content_block: { type: "tool_use", id: tool.id, name: tool.function.name, input: {} } },
                    { type: "content_block_delta", index: tool.index, delta: { type: "input_json_delta", partial_json: tool.function.arguments } },
                    { type: "content_block_stop", index: tool.index },
                ]) : [
                    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Verified." } },
                    { type: "content_block_stop", index: 0 },
                ];
                const frames = [
                    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "fixture", content: [],
                        stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 0 } } },
                    ...blocks,
                    { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
                    { type: "message_stop" },
                ];
                response.end(frames.map((value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(""));
                return;
            }
            response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
            const profile = { executable: process.env.PLURNK_BENCH_PI, version: "fixture", provider, model: "fixture",
                baseUrl: `http://127.0.0.1:${server.address().port}/v1`, effort, turnCap, maxOutputTokens: 32768,
                timeoutSeconds: 30, contextWindow: 1000000, rates };
            json(join(configDir, "settings.json"), piConfiguration(shellPath));
            json(join(configDir, "models.json"), { providers: { [provider]: {
                baseUrl: profile.baseUrl, api, apiKey: `$${credential}`,
                models: [{ id: "fixture", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 32768, cost: rates,
                    ...(api === "anthropic-messages" ? { compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { xhigh: "xhigh" } } : {}) }],
            } } });
            json(join(agent, "profile.json"), profile);
            const launch = piLaunch(profile.executable, piArguments(profile, join(agent, "sessions"), "Run the tool check."));
            const result = await runToFiles(launch.command, launch.args, {
                cwd: repo, env: { ...process.env, [credential]: "fixture-not-a-credential", PI_CODING_AGENT_DIR: configDir,
                    PATH: `${agent}:${process.env.PATH}`, PI_TELEMETRY: "0", PLURNK_PI_PROFILE: join(agent, "profile.json"), PLURNK_PI_AGENT_DIR: agent,
                    NODE_OPTIONS: "" },
                stdoutPath: join(agent, "pi.stdout.jsonl"), stderrPath: join(agent, "pi.stderr.log"), timeoutMs: 30000,
            });
            assert.equal(result.status, 0, readFileSync(join(agent, "pi.stderr.log"), "utf8"));
            assert.equal(requests.length, turnCap === 1 ? 1 : 2, readFileSync(join(agent, "pi.stdout.jsonl"), "utf8") + readFileSync(join(agent, "pi.stderr.log"), "utf8"));
            assert.deepEqual(requests[0].tools.map((tool) => api === "anthropic-messages" ? tool.name : tool.function.name).sort(), ["bash", "edit", "read", "write"]);
            for (const request of requests) {
                if (api === "anthropic-messages") {
                    assert.equal(request.max_tokens, 32768);
                    assert.equal(request.thinking.type, "adaptive");
                    assert.equal(request.output_config.effort, effort);
                } else if (provider === "openrouter") assert.equal(request.reasoning.effort, effort);
                else assert.equal(request.reasoning_effort, effort);
                if (api === "openai-completions") assert.equal(request.max_tokens, undefined);
                assert.equal(request.frequency_penalty, undefined);
                assert.doesNotMatch(JSON.stringify(request.messages), /FORBIDDEN_PERSONAL_CONTEXT_MARKER|Operation Syntax|plurnk\.md/);
            }
            assert.equal(readFileSync(join(repo, "native.txt"), "utf8"), "native write");
            if (turnCap > 1) assert.match(JSON.stringify(requests[1].messages), /NATIVE_SHELL_PATH_USED/);
            const summary = summarizePi(agent, rates);
            assert.equal(summary.responsesWithUsage, requests.length);
            assert.equal(summary.unpricedRequests, provider === "fireworks" ? requests.length : 0);
            assert.equal(summary.responsesWithTokenBreakdown, requests.length);
            assert.equal(summary.repricedUsd, 0.00000815 * requests.length);
            assert.equal(summary.chargedUsd, provider === "fireworks" ? null : 0.003 * requests.length);
            assert.equal(summary.limits.length, turnCap === 1 ? 1 : 0);
        } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    });
}
