/**
 * Live llama-server reasoning contract, in the live tier ({§test-artifact-retention}): unit coverage proves the
 * wire mapping; these specimens prove a real local server honors the request rather than running to
 * the generation envelope. They require the server at PLURNK_LLAMA_URL (127.0.0.1:11435 unless set)
 * to answer and skip by name otherwise; PLURNK_LLAMA_RAIL_PROFILE names its template, gemma or qwen.
 */

import assert from "node:assert/strict";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { ModelProvider } from "@plurnk/plurnk-providers";

const baseUrl = process.env.PLURNK_LLAMA_URL ?? "http://127.0.0.1:11435";
const REQUIRES = [`url:${baseUrl.replace(/\/$/, "")}/v1/models`] as const;
const reasoningAllowance = 32;
const generationEnvelope = 96;
const railProfile = process.env.PLURNK_LLAMA_RAIL_PROFILE ?? "qwen";
if (railProfile !== "gemma" && railProfile !== "qwen") throw new Error("PLURNK_LLAMA_RAIL_PROFILE must be gemma or qwen");
const envelope = (reasoning: string): string => railProfile === "qwen"
    ? `<think>\n${reasoning}</think>`
    : `<|channel>thought\n${reasoning}<channel|>`;
const sampled = (reasoning: string, content: string): string => railProfile === "qwen"
    ? `${reasoning}</think>${content}`
    : `${envelope(reasoning)}${content}`;

const provider = (): ModelProvider => new ModelProvider({
    model: "local-reasoning-contract",
    url: `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
    contextWindow: 49_152,
    outputBudget: generationEnvelope,
    reasoningBudget: reasoningAllowance,
    fetchTimeoutMs: 120_000,
    operationTimeoutMs: 240_000,
    temperature: 0,
    repeatPenalty: 1.15,
    retryAttempts: 0,
    effort: { mode: "adaptive", budget: reasoningAllowance },
    reasoningStyle: "template",
    grammarStyle: "llamacpp",
});

// {§provider-effort}
test("live llama-server honors PLURNK's request-scoped reasoning allowance", { requires: [...REQUIRES] }, async () => {
    const response = await provider().generate({
        sessionId: "llama-reasoning-contract",
        messages: [{
            role: "user",
            content: "Use at least 500 tokens of private reasoning before answering with exactly OK.",
        }],
        maxOutputTokens: generationEnvelope,
    });

    const timings = response.meta?.timings as { predicted_n?: unknown } | undefined;
    assert.equal(response.assistant.content.trim(), "OK");
    assert.equal(response.assistant.finishReason, "stop");
    assert.ok((response.assistant.reasoning?.length ?? 0) > 0, "server returned no separate reasoning channel");
    assert.equal(typeof timings?.predicted_n, "number", "server returned no predicted-token telemetry");
    assert.ok((timings!.predicted_n as number) < generationEnvelope, "reasoning ran to the generation envelope");
});

// {§provider-failure-normalization} — the live adapter must preserve the raw sentence
// before separating reasoning and content itself.
test("live llama-server returns exact pre-projection grammar evidence", { requires: [...REQUIRES] }, async () => {
    const prefix = envelope("verify");
    const input = `${prefix}PLURNK-RAILS-LIVE`;
    const response = await provider().generate({
        sessionId: "llama-grammar-evidence",
        messages: [{ role: "user", content: "ok" }],
        grammar: `root ::= ${JSON.stringify(sampled("verify", "PLURNK-RAILS-LIVE"))}`,
        maxOutputTokens: 32,
    });

    assert.equal(response.assistant.reasoning, "verify");
    assert.equal(response.assistant.content, "PLURNK-RAILS-LIVE");
    assert.deepEqual(response.grammarEvidence, {
        input,
        contentStart: Array.from(prefix).length,
        transported: true,
    });
});

test("live llama-server preserves an empty grammar-required reasoning channel", { requires: [...REQUIRES] }, async () => {
    const prefix = envelope("");
    const input = `${prefix}PLURNK-EMPTY-RAILS-LIVE`;
    const response = await provider().generate({
        sessionId: "llama-empty-grammar-evidence",
        messages: [{ role: "user", content: "ok" }],
        grammar: `root ::= ${JSON.stringify(sampled("", "PLURNK-EMPTY-RAILS-LIVE"))}`,
        maxOutputTokens: 32,
    });

    assert.equal(response.assistant.reasoning, null);
    assert.equal(response.assistant.content, "PLURNK-EMPTY-RAILS-LIVE");
    assert.deepEqual(response.grammarEvidence, {
        input,
        contentStart: Array.from(prefix).length,
        transported: true,
    });
});
