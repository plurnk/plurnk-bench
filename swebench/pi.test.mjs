import assert from "node:assert/strict";
import { after, test } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drainCaptures, observeFetch } from "./pi-observer.mjs";
import { piArguments, piConfiguration, piLaunch, summarizePi, validateProfile } from "./pi.mjs";
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
    assert.deepEqual(summary.usage, { input: 20, cacheRead: 5, cacheWrite: 0, output: 10, reasoning: 4 });
    assert.equal(summary.repricedUsd, 0.00000815);
    writeFileSync(join(wire, "0001.response.txt"), raw.replace(',"upstream_inference_cost":0.002', '').replace('"upstream_inference_cost":0.002', ''));
    assert.equal(summarizePi(agent, rates).unpricedRequests, 1);
    assert.equal(summarizePi(agent, rates).chargedUsd, 0);
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
    assert.match(summary.failures[0].error, /Incomplete provider frame/);
});

test("{§swebench-pi} profiles require explicit route, version, limits and rates", () => {
    assert.throws(() => validateProfile({}), /OpenRouter/);
    assert.throws(() => validateProfile({ provider: "openrouter" }), /executable/);
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
});

for (const { name, limits, errors, failures = [], pause } of [
    { name: "recorded turn-cap abort", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "This operation was aborted" }], pause: false },
    { name: "unexplained abort", limits: [],
        errors: [{ stopReason: "error", error: "This operation was aborted" }], pause: true },
    { name: "provider failure despite a cap", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "HTTP 503: unavailable" }], pause: true },
    { name: "earlier provider failure before a cap", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "HTTP 503: unavailable" },
            { stopReason: "error", error: "This operation was aborted" }], pause: true },
    { name: "capture failure despite a cap", limits: [{ event: "turn-cap", turnCap: 100 }],
        errors: [{ stopReason: "error", error: "This operation was aborted" }],
        failures: [{ error: "Response capture interrupted" }], pause: true },
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
            json(join(artifact, "result.json"), { exception_info: null });
            return { status: 0 };
        };
        if (pause) await assert.rejects(runCampaign(options, execute), /paused for review/);
        else await runCampaign(options, execute);
        assert.equal(calls, pause ? 1 : 2);
        const results = readFileSync(join(options.out, "results.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        assert.equal(results[0].pause, pause);
        assert.deepEqual(results[0].summary.errors, errors);
        assert.deepEqual(results[0].summary.limits, limits);
        assert.equal(results[0].reward.reward, 0);
        if (!pause) {
            await runCampaign(options, execute);
            assert.equal(calls, 2);
        }
    });
}

for (const turnCap of [1, 100]) {
    test(`{§swebench-pi} installed native Pi: isolated context, tools, wire effort and ${turnCap}-turn bound`, {
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
            const frame = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
                choices: [{ index: 0, delta: { role: "assistant", ...(first ? { tool_calls: tools } : { content: "Verified." }) }, finish_reason: first ? "tool_calls" : "stop" }], usage };
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
            const profile = { executable: process.env.PLURNK_BENCH_PI, version: "fixture", provider: "openrouter", model: "fixture",
                baseUrl: `http://127.0.0.1:${server.address().port}/v1`, effort: "low", turnCap, maxOutputTokens: 32768,
                timeoutSeconds: 30, contextWindow: 1000000, rates };
            json(join(configDir, "settings.json"), piConfiguration(shellPath));
            json(join(configDir, "models.json"), { providers: { openrouter: {
                baseUrl: profile.baseUrl, api: "openai-completions", apiKey: "$OPENROUTER_API_KEY",
                models: [{ id: "fixture", reasoning: true, input: ["text"], contextWindow: 1000000, maxTokens: 32768, cost: rates }],
            } } });
            json(join(agent, "profile.json"), profile);
            const launch = piLaunch(profile.executable, piArguments(profile, join(agent, "sessions"), "Run the tool check."));
            const result = await runToFiles(launch.command, launch.args, {
                cwd: repo, env: { ...process.env, OPENROUTER_API_KEY: "fixture-not-a-credential", PI_CODING_AGENT_DIR: configDir,
                    PATH: `${agent}:${process.env.PATH}`, PI_TELEMETRY: "0", PLURNK_PI_PROFILE: join(agent, "profile.json"), PLURNK_PI_AGENT_DIR: agent,
                    NODE_OPTIONS: "" },
                stdoutPath: join(agent, "pi.stdout.jsonl"), stderrPath: join(agent, "pi.stderr.log"), timeoutMs: 30000,
            });
            assert.equal(result.status, 0, readFileSync(join(agent, "pi.stderr.log"), "utf8"));
            assert.equal(requests.length, turnCap === 1 ? 1 : 2, readFileSync(join(agent, "pi.stdout.jsonl"), "utf8") + readFileSync(join(agent, "pi.stderr.log"), "utf8"));
            assert.deepEqual(requests[0].tools.map((tool) => tool.function.name).sort(), ["bash", "edit", "read", "write"]);
            for (const request of requests) {
                assert.equal(request.max_tokens, undefined);
                assert.equal(request.reasoning.effort, "low");
                assert.equal(request.frequency_penalty, undefined);
                assert.doesNotMatch(JSON.stringify(request.messages), /FORBIDDEN_PERSONAL_CONTEXT_MARKER|Operation Syntax|plurnk\.md/);
            }
            assert.equal(readFileSync(join(repo, "native.txt"), "utf8"), "native write");
            if (turnCap > 1) assert.match(JSON.stringify(requests[1].messages), /NATIVE_SHELL_PATH_USED/);
            const summary = summarizePi(agent, rates);
            assert.equal(summary.responsesWithUsage, requests.length);
            assert.equal(summary.unpricedRequests, 0);
            assert.equal(summary.limits.length, turnCap === 1 ? 1 : 0);
        } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    });
}
