// Live OpenAI-surface coverage: a multi-turn loop the model drives to terminal,
// and a single-shot store-and-reply. Both run through the REAL prod loop (loop.run
// via the daemon — liveWorkspace + liveLoop), so they exercise the path production
// runs, not a hand-built engine. Packet-shape invariants (definition leads with the
// sysprompt, ops==statuses) are asserted deterministically in the intg tier
// (packet-assembled, scheme-education); here we assert the LIVE outcome — the model
// drives the loop to a clean terminal and the right entries land in the db.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop, seedEntry } from "@plurnk/plurnk-service/harness";

test("live OpenAI: a multi-turn loop consumes a next-packet READ result and concludes with it", async (t) => {
    const s = await liveWorkspace({ name: `live-loop-${crypto.randomUUID()}` });
    try {
        // The random secret requires retrieval and consumption of the next packet's result.
        // Completion after actions is enforced by the runtime, not by the grammar.
        const secret = crypto.randomUUID().slice(0, 8);
        await seedEntry(s.db, s.workspaceId, { pathname: "vault/code.md", content: `the access code is ${secret}` });
        const userPrompt = "What is the access code stored at workspace:///vault/code.md? Tell me in one sentence.";
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPrompt, maxTurns: 6 }, { signal: t.signal });

        const turns = await Promise.all(turnIds.map(async (turnId) => ({
            turnId,
            turn: await s.db.test_get_turn.get<{
                status: number;
                packet: string | null;
                producer: string;
                kind: string;
            }>({ id: turnId }),
        })));
        console.log(`\n=== multi-turn run (${turnIds.length} durable turns, final ${finalStatus}) ===`);
        for (const [i, { turnId, turn }] of turns.entries()) {
            const requests = await s.db.test_provider_requests.all<{ usage_output: number | null }>({ turn_id: turnId });
            const outputTokens = requests.reduce<number | null>((total, request) =>
                total === null || request.usage_output === null ? null : total + request.usage_output, 0);
            const packet = JSON.parse(turn?.packet ?? "{}") as { assistant: { content: string } };
            console.log(`\n--- turn ${i + 1} (${turn?.producer}/${turn?.kind}, status ${turn?.status}, ${outputTokens ?? "unknown"} output tokens) ---`);
            console.log(packet.assistant?.content ?? "(no provider inference)");
        }

        const modelTurns = turns.filter(({ turn }) => turn?.producer === "model" && turn.kind === "inference");
        assert.ok(modelTurns.length >= 2, "the READ result forces two inference turns because it arrives in the next model packet");
        assert.equal(finalStatus, 200, `loop must conclude successfully; got ${finalStatus}`);
        assert.ok(lastContent.includes(secret), `the conclusion carries the seeded secret '${secret}' — proof the next-packet result was consumed; got: ${lastContent.slice(0, 200)}`);
    } finally { await s.cleanup(); }
});

test("live OpenAI: a single-shot store-and-reply terminates cleanly", async (t) => {
    const s = await liveWorkspace({ name: `live-smoke-${crypto.randomUUID()}` });
    try {
        const userPrompt = "What is the capital of France? Store the answer under workspace:///france/capital and conclude with the answer.";
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPrompt, maxTurns: 6 }, { signal: t.signal });

        assert.equal(finalStatus, 200, `single-shot store-and-reply must conclude successfully; got ${finalStatus}`);
        assert.ok(turnIds.length >= 1, "at least one turn ran");
        assert.match(lastContent, /\bParis\b/i, "the successful conclusion contains the answer");

        const stored = await s.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
            pathname: "/france/capital",
            scheme: "workspace",
            name: "body",
        });
        assert.match(stored?.content ?? "", /\bParis\b/i, "workspace:///france/capital contains the answer");
    } finally { await s.cleanup(); }
});
