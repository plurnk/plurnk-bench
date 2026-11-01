/**
 * Live llama-server reasoning contract, in the live tier ({§tier-corpus}): unit coverage proves the
 * wire mapping; this specimen proves a real local server honors the request rather than running to
 * the generation envelope. It requires the server at PLURNK_LLAMA_URL (127.0.0.1:11435 unless set)
 * to answer and skips by name otherwise.
 */

import assert from "node:assert/strict";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { ModelProvider } from "@plurnk/plurnk-providers";

const baseUrl = process.env.PLURNK_LLAMA_URL ?? "http://127.0.0.1:11435";
const REQUIRES = [`url:${baseUrl.replace(/\/$/, "")}/v1/models`] as const;
const reasoningAllowance = 32;
const generationEnvelope = 96;

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
});

// {§tier-corpus}
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
