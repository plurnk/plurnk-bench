import assert from "node:assert/strict";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { liveLoop, liveWorkspace } from "@plurnk/plurnk-service/harness";

test("{§op-methods-op-dispatch} live: delegate two isolated questions and consume their answers", async (t) => {
    const s = await liveWorkspace({ name: `live-bare-${crypto.randomUUID()}` });
    try {
        // {§op-shapes} — the taught form only: BARE carries its prompt in the fence body (#848).
        const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, {
            prompt: "Use two separate BARE calls, each with its own inline prompt: one asking for the capital of France, the other for the capital of Germany. Then report both answers.",
            maxTurns: 6,
        }, { signal: t.signal });

        assert.equal(finalStatus, 200, "the parent concludes after receiving both inference results");
        assert.match(lastContent, /\bBerlin\b/i, "the conclusion includes the German capital");
        assert.match(lastContent, /\bParis\b/i, "the conclusion includes the French capital");

        const calls = (await Promise.all(turnIds.map((turnId) =>
            s.db.test_model_calls.all<{ kind: string; state: string; log_entry_id: number | null }>({ turn_id: turnId }),
        ))).flat().filter(({ kind }) => kind === "bare");
        // {§engine-rails} — a failed BARE is re-issued as its own call (#829): count the served
        // delegations, not the attempts.
        const served = calls.filter(({ state }) => state === "response");
        assert.equal(served.length, 2, "two served isolated provider calls answered the requested delegation");
        assert.ok(calls.every(({ state }) => state !== "open"), "no BARE call is left open");
        assert.ok(served.every(({ log_entry_id }) => log_entry_id !== null), "both responses have ordinary durable log receipts");
        const rows = (await Promise.all(turnIds.map((turnId) =>
            s.db.test_log_entries_by_turn.all<{ op: string | null; pathname: string | null }>({ turn_id: turnId }),
        ))).flat();
        assert.equal(rows.filter(({ op }) => op === "BARE").length, 2, "two BARE operations were dispatched");
    } finally {
        await s.cleanup();
    }
});
