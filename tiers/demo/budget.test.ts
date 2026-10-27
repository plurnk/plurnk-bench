// The context room, with a real model ({§tokenomics}): two stories, each a live test of one
// key rule the intg tier pins deterministically. The wall ({§tokenomics}) stays intg-only: it
// needs engineered output, not a model.
//
// Every story is read friction first: a refused or failed model operation is a failure here even
// when the final text is right, and so is a turn that answers an over-budget packet with anything
// but KILL, MOVE or NOTE ({§tokenomics}).

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@plurnk/plurnk-service/harness";
import { LogEntryProjection } from "@plurnk/plurnk-service/harness";
import { RESULT_EXCEEDS_BUDGET } from "@plurnk/plurnk-service/harness";
import { liveLoop, liveWorkspace, pinAliasInputCapacity } from "@plurnk/plurnk-service/harness";
import { failAfterCleanup } from "@plurnk/plurnk-service/harness";
import { measureFloor } from "./_floor-probe.ts";
import { assertContextFitEvidence, seedAttachmentFixture } from "@plurnk/plurnk-service/harness";
import { initializeDemoRepository } from "@plurnk/plurnk-service/harness";

const OVER_BUDGET = "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn."; // {§operation-results}
const CURATION = new Set(["KILL", "MOVE", "NOTE"]);

interface LoopRow { id: number; turn_id: number; op: string | null; origin: string; status_rx: number; rx: string; attrs: string }

// {§tokenomics} {§tokenomics} — the loop's discipline: every turn whose packet was
// over, its head carrying the over-budget row, was answered with curation alone, and no model
// operation was refused. Fit receipts ({§tokenomics}) are outcomes, never friction.
const assertBudgetDiscipline = async (db: Db, loopId: number): Promise<{ overTurns: number; modelTurns: number }> => {
    const turns = await db.test_list_turns_in_loop.all<{ id: number; kind: string; status: number; packet: string | null }>({ loop_id: loopId });
    const rows = await db.test_log_entries_by_loop.all<LoopRow>({ loop_id: loopId });
    assert.ok(turns.every(({ status }) => status !== 413), "{§tokenomics}: no packet met the wall; the limit protects a loop, it never ends one");
    const refused = rows.flatMap((row) => {
        if (row.origin !== "model" || row.status_rx < 400) return [];
        const type = (JSON.parse(row.rx) as { problem?: { type?: string } }).problem?.type ?? "";
        return type === RESULT_EXCEEDS_BUDGET ? [] : [`${row.op} ${row.status_rx} ${type.split("/").slice(-2).join("/")}`];
    });
    assert.deepEqual(refused, [], "friction first: no model operation was refused or failed, and no strike was recorded");
    let overTurns = 0;
    for (const turn of turns) {
        const over = rows.some((row) => row.turn_id === turn.id && row.origin === "_plurnk"
            && (JSON.parse(row.rx) as { problem?: { detail?: string } }).problem?.detail === OVER_BUDGET);
        if (!over) continue;
        overTurns += 1;
        const program = rows.filter((row) => row.turn_id === turn.id && row.origin === "model" && !LogEntryProjection.isEmission(row));
        const offending = program.filter(({ op }) => op === null || !CURATION.has(op)).map(({ op }) => op);
        assert.deepEqual(offending, [], `turn ${turn.id} answered an over-budget packet with ${offending.join(", ")}: only KILL, MOVE or NOTE may follow the row`);
    }
    return { overTurns, modelTurns: turns.filter(({ kind, packet }) => kind === "inference" && packet !== null).length };
};

// A git-committed workspace holding one uniform-density ledger: 600 lines of the same width, so
// the tokens-per-line clue is reliable, and one fact buried past any prefix the room can hold.
const seedLedgerFixture = async (): Promise<{ workspace: string; cleanup: () => Promise<void> }> => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-budget-ledger-"));
    const lines: string[] = [];
    for (let i = 1; i <= 600; i += 1) {
        lines.push(`Entry ${String(i).padStart(4, "0")}: routine ledger record number ${i}; standard operational note, nothing of special interest is filed on this particular line.`);
    }
    lines[316] = "Entry 0317: the emergency shutdown code for the primary reactor core is CRIMSON-MERIDIAN-84, filed by the audit team and paged to no one.";
    await writeFile(join(workspace, "ledger.md"), `${lines.join("\n")}\n`);
    initializeDemoRepository(workspace, "ledger");
    return { workspace, cleanup: async () => { await rm(workspace, { recursive: true, force: true }); } };
};

// {§tokenomics} {§tokenomics} — attachments beyond the room land as receipts, the longest prefix
// of lines above each; the model retrieves an answer absent from its opening packet.
test("budget: attachments beyond the room land as receipts; the model retrieves the recovery site", { requires: ["output-budget"] }, async (t) => {
    const fixture = await seedAttachmentFixture();
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    try {
        const floor = await measureFloor({ signal: t.signal, label: "receipts", projectRoot: fixture.workspace, prompt: fixture.prompt });
        // Twice the floor: a batch of sixteen reserves a receipt each, so the first attachments land whole
        // and the rest are receipts — both shapes in one packet.
        const capacity = Math.round(floor.weight * 2);
        lifetime.defer(pinAliasInputCapacity({ inputCapacity: capacity, outputBudget: floor.outputBudget }));
        const s = await liveWorkspace({ name: `demo-budget-receipts-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        console.error(`[budget:receipts] runDir=${s.runDir} floor=${floor.weight} capacity=${capacity} effective=${s.provider.inputCapacity} outputBudget=${s.provider.outputBudget}`);
        const result = await liveLoop(s, 2, { prompt: fixture.prompt, openPaths: fixture.openPaths, maxTurns: 12 }, { signal: t.signal });
        const evidence = await assertContextFitEvidence({ db: s.db, daemon: s.daemon, workspaceId: s.workspaceId, sessionId: result.modelSessionId, turnIds: result.turnIds, fixture });
        const discipline = await assertBudgetDiscipline(s.db, result.loopId);
        console.error(`[budget:receipts] landed=${evidence.landed} receipts=${evidence.receipts} modelTurns=${discipline.modelTurns} overTurns=${discipline.overTurns} finalStatus=${result.finalStatus}`);
        assert.ok(evidence.landed > 0 && evidence.receipts > 0, `the room held some attachments whole and the rest as receipts: landed=${evidence.landed} receipts=${evidence.receipts}`);
        assert.equal(result.finalStatus, 200, "the model retrieves the omitted answer and completes the task");
        assert.ok(result.lastContent.includes(fixture.answer), `the model reports the recorded recovery site; got: ${result.lastContent.slice(0, 300)}`);
    } catch (error) {
        await failAfterCleanup(error, () => lifetime.disposeAsync());
    }
    await lifetime.disposeAsync();
});

// {§tokenomics} {§tokenomics} {§tokenomics} — a task that demands a long NOTE in a
// tight room: the whole READ lands as a prefix above its receipt, the model curates with the verbs and
// reaches the buried fact by FIND and a range READ; a packet that does go over budget is answered with
// curation alone. A model that curates ahead of the pressure never sees the row, and that is the
// product working; the row's own mechanics are the intg tier's.
test("budget: a long NOTE in a tight room — receipts by prefix, curation by the verbs, the buried code by range", { requires: ["output-budget"] }, async (t) => {
    const doc = await seedLedgerFixture();
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(doc.cleanup);
    const prompt = "First keep a NOTE quoting ledger.md entries 1 through 25 verbatim, one per line, so they survive curation. Then report the emergency shutdown code for the primary reactor core that ledger.md records.";
    try {
        const floor = await measureFloor({ signal: t.signal, label: "over-budget", projectRoot: doc.workspace, prompt });
        const capacity = Math.round(floor.weight * 1.4);
        lifetime.defer(pinAliasInputCapacity({ inputCapacity: capacity, outputBudget: floor.outputBudget }));
        const s = await liveWorkspace({ name: `demo-budget-over-${crypto.randomUUID()}`, projectRoot: doc.workspace });
        lifetime.defer(s.cleanup);
        console.error(`[budget:over] runDir=${s.runDir} floor=${floor.weight} capacity=${capacity} effective=${s.provider.inputCapacity} outputBudget=${s.provider.outputBudget}`);
        const result = await liveLoop(s, 2, { prompt, maxTurns: 14 }, { signal: t.signal });
        const discipline = await assertBudgetDiscipline(s.db, result.loopId);
        console.error(`[budget:over] modelTurns=${discipline.modelTurns} overTurns=${discipline.overTurns} finalStatus=${result.finalStatus}`);
        assert.equal(result.finalStatus, 200, "the loop completes under the pressure");
        assert.match(result.lastContent, /CRIMSON-MERIDIAN-84/u, `the buried code is reported; got: ${result.lastContent.slice(0, 300)}`);
    } catch (error) {
        await failAfterCleanup(error, () => lifetime.disposeAsync());
    }
    await lifetime.disposeAsync();
});
