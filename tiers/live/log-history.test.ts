// Composed real-model drill for {§tier-corpus}. Deterministic
// integration coverage owns the complete state matrix; this specimen proves
// that the production loop, broad log KILL, and forensic digest retain the
// same append-only contract end to end.

import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { liveLoop, liveWorkspace } from "@plurnk/plurnk-service/harness";
import { LogEntryProjection } from "@plurnk/plurnk-service/harness";


test("live: broad log KILL retires READ receipts without erasing program artifacts", async (t) => {
    const s = await liveWorkspace({ name: `live-log-history-${crypto.randomUUID()}` });
    let cleaned = false;
    try {
        const primed = await liveLoop(
            s,
            2,
            {
                prompt: "Read plurnk:///pattern.md, then reply with `ready`.",
                maxTurns: 4,
            },
            { signal: t.signal },
        );
        assert.equal(primed.finalStatus, 200, "the first loop establishes finite prior turn history");
        const primedTurnId = primed.turnIds.at(-1);
        assert.notEqual(primedTurnId, undefined);
        const primedTurn = await s.db.test_get_turn.get<{ loop_id: number }>({ id: primedTurnId! });
        assert.ok(primedTurn);
        const priorPrograms = await s.db.test_turn_sources.all<{
            turn_id: number; kind: string; sequence: number; content: string; producer: string;
        }>({ session_id: primed.modelSessionId });
        // {§tier-corpus} — initialization records its survey program and authors no reasoning.
        assert.ok(priorPrograms.some(({ kind, producer }) => kind === "ops" && producer === "_plurnk"),
            "initialization records its survey as a program source");
        assert.ok(!priorPrograms.some(({ kind, producer }) => kind === "reasoning" && producer === "_plurnk"),
            "initialization authors no reasoning");
        assert.ok(priorPrograms.some(({ kind, producer }) => kind === "ops" && producer === "model"),
            "the completed model turn establishes a content program");
        const priorReads = (await s.db.test_log_entries_by_loop.all<{
            id: number; op: string | null; active: number; attrs: string;
        }>({ loop_id: primedTurn.loop_id })).filter((row) => row.op === "READ" && !LogEntryProjection.isEmission(row) && !LogEntryProjection.isReasoning(row));
        const activePriorIds = priorReads.filter(({ active }) => active === 1).map(({ id }) => id);
        assert.ok(activePriorIds.length > 0, "the first loop's READ is available for curation");

        const { finalStatus, modelSessionId, turnIds } = await liveLoop(
            s,
            3,
            {
                prompt: "Retire every READ observation from the prior loop with one broad KILL against `log:///1/**/READ`, then confirm completion without curating this loop.",
                maxTurns: 4,
            },
            { signal: t.signal },
        );
        assert.equal(finalStatus, 200, "the model completes after curating its prior READ observations");

        const effects = await s.db.test_log_curation_effects_by_session.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: number;
            active_after: number;
            op: string;
            turn_id: number;
        }>({ session_id: modelSessionId });
        const killedReads: number[] = [];
        const killOperations = new Set<number>();
        for (const effect of effects) {
            if (!turnIds.includes(effect.turn_id)) continue;
            if (effect.op !== "KILL" || effect.active_before !== 1 || effect.active_after !== 0) continue;
            const target = await s.db.test_log_entries_get_by_id.get<{ op: string | null }>({ id: effect.target_log_entry_id });
            if (target?.op === "READ") {
                killedReads.push(effect.target_log_entry_id);
                killOperations.add(effect.operation_log_entry_id);
            }
        }
        assert.deepEqual(
            killedReads.toSorted((a, b) => a - b),
            activePriorIds.toSorted((a, b) => a - b),
            "the requested KILL retires every still-active prior READ, independent of preparatory curation",
        );
        assert.equal(killOperations.size, 1, "one broad KILL owns the complete retired target set");
        const retainedSources = await s.db.test_turn_sources.all<{
            turn_id: number; kind: string; sequence: number; content: string;
        }>({ session_id: modelSessionId });
        for (const source of priorPrograms) {
            const retained = retainedSources.find(({ turn_id, kind, sequence }) =>
                turn_id === source.turn_id && kind === source.kind && sequence === source.sequence);
            assert.equal(retained?.content, source.content, `immutable ${source.kind} source survives curation`);
        }

        await s.cleanup();
        cleaned = true;

        const digestDir = join(s.runDir, "digest");
        const digest = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")) as {
            turns: Array<{ id: number; program: string | null; artifact: string | null }>;
            log_entries: Array<{ id: number; projection: { active: boolean } }>;
        };
        const durablePrograms = digest.turns.toSorted((a, b) => a.id - b.id)
            .flatMap(({ program }) => program === null ? [] : [program]);
        assert.ok(
            priorReads.every(({ id }) => digest.log_entries.some((entry) => entry.id === id && !entry.projection.active)),
            "every retired READ remains durable and forensically marked inactive",
        );

        // {§tier-corpus}: artifacts are named by log coordinate; the digest's turn order is chronological.
        const assistantArtifacts = digest.turns.toSorted((a, b) => a.id - b.id)
            .flatMap(({ artifact, program }) => artifact === null || program === null ? [] : [`${artifact}.assistant.md`]);
        const artifactSources = await Promise.all(assistantArtifacts.map((name) => readFile(join(digestDir, name), "utf8")));
        assert.deepEqual(artifactSources, durablePrograms, "every admitted program remains an exact chronological artifact");
        for (const { turn_id, kind, content } of priorPrograms.filter((program) => program.kind === "ops" || program.kind === "reasoning")) {
            const turn = digest.turns.find(({ id }) => id === turn_id);
            assert.ok(turn?.artifact, `source turn ${turn_id} remains in the digest`);
            const channel = kind === "ops" ? "assistant" : "reasoning";
            assert.equal(await readFile(join(digestDir, `${turn.artifact}.${channel}.md`), "utf8"), content,
                `curating READ receipts cannot erase or move the ${kind} source of turn ${turn_id}`);
        }
    } finally {
        if (!cleaned) await s.cleanup();
    }
});
