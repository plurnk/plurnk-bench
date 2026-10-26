// Live exec — STRUCTURAL prompts allowed here. The model is explicitly
// told to use the execution op shape per plurnk.md; we're testing the
// machinery (parser → engine → exec scheme → spawn → channels → wake)
// against a real provider, not the model's tool-discovery ability.
//
// Driven through the REAL prod loop (loop.run via the daemon — liveWorkspace +
// liveLoop). The daemon wires the executors itself (Daemon.start), so this no
// longer hand-builds an ExecutorRegistry; the loop's completion implies the
// backgrounded spawn finished (the model concluded only after reading its result).

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";

test("live exec: model emits a sh fence and the spawn captures stdout", async (t) => {
    const s = await liveWorkspace({ name: `live-exec-${crypto.randomUUID()}` });
    try {
        const userPrompt = [
            "Two-turn probe.",
            "",
            "If you see the exec's stdout stream (a `sh:///...` entry) containing",
            "`plurnk-exec-live-ok`, emit this complete turn:",
            PlurnkParser.frame("SEND [200]", "plurnk-exec-live-ok"),
            "",
            "Otherwise, emit this complete turn to run `echo plurnk-exec-live-ok` and await its result:",
            PlurnkParser.frame("sh", "echo plurnk-exec-live-ok"),
            PlurnkParser.frame("WAIT", "Await the stdout probe result."),
            "",
            "Do not repeat the command once you see the `sh:///...` stream entry in the log.",
        ].join("\n");

        const { finalStatus, hitMaxTurns, lastContent, turnIds } = await liveLoop(s, 2, { prompt: userPrompt, maxTurns: 8 }, { signal: t.signal });

        const dumpTurns = async (): Promise<void> => {
            for (const turnId of turnIds) {
                const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 400)}`);
            }
        };
        if (finalStatus !== 200) await dumpTurns();
        assert.equal(finalStatus, 200);
        assert.equal(hitMaxTurns, false);
        assert.equal(lastContent.trim(), "plurnk-exec-live-ok", "the model reports the observed stdout to the client");

        // {§exec}: inspect the real invocation's retained stdout, not just its receipt.
        const execEntryCount = (await s.db.test_count_entries_by_workspace_scheme.get<{ n: number }>({
            workspace_id: s.workspaceId, scheme: "sh",
        }))?.n ?? 0;
        assert.ok(execEntryCount >= 1, "at least one sh:/// exec-output entry was created");

        // Find the exec-output entry and verify its stdout captured the probe. We don't
        // know the auto-generated coordinate from outside; list workspace entries to find
        // any sh:///<coord>.
        type EntryListRow = { scheme: string; pathname: string };
        const allEntries = await s.db.test_list_entries_by_workspace_workspace_pathname.all<EntryListRow>({ workspace_id: s.workspaceId });
        const execEntries = allEntries.filter((e) => e.scheme === "sh");
        let foundProbe = false;
        for (const e of execEntries) {
            const entryRow = await s.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
                scheme: "sh", pathname: e.pathname,
            });
            if (entryRow === undefined) continue;
            const stdout = await s.db.test_get_channel.get<{ content: string; state: string }>({
                entry_id: entryRow.id, name: "stdout",
            });
            if ((stdout?.content ?? "").includes("plurnk-exec-live-ok")) {
                foundProbe = true;
                assert.equal(stdout?.state, "closed");
                break;
            }
        }
        if (!foundProbe) {
            await dumpTurns();
            for (const e of execEntries) {
                const entryRow = await s.db.test_get_entry_by_pathname_scheme.get<{ id: number }>({
                    scheme: "sh", pathname: e.pathname,
                });
                if (entryRow === undefined) continue;
                const stdout = await s.db.test_get_channel.get<{ content: string; state: string }>({
                    entry_id: entryRow.id, name: "stdout",
                });
                console.error(`sh:///${e.pathname} stdout: state=${stdout?.state} content=${JSON.stringify(stdout?.content)}`);
            }
        }
        assert.ok(foundProbe, "an exec stdout channel captured the probe string");
    } finally { await s.cleanup(); }
});
