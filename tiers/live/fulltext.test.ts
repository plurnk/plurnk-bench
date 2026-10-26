import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop, seedEntry } from "@plurnk/plurnk-service/harness";


test("live: full-text FIND — locate a note by its words without surveying each body", async (t) => {
    const s = await liveWorkspace({ name: `live-fulltext-find-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, {
            pathname: "notes/alpha.md",
            content: "A cracked rubber irrigation tube can be repaired with a barbed coupling and two clamps.",
        });
        await seedEntry(s.db, s.workspaceId, {
            pathname: "notes/bravo.md",
            content: "A TLS handshake authenticates peers and negotiates encryption parameters.",
        });
        await seedEntry(s.db, s.workspaceId, {
            pathname: "notes/charlie.md",
            content: "Bread dough develops structure when kneading aligns its gluten network.",
        });
        const { finalStatus, lastContent, modelSessionId } = await liveLoop(
            s,
            2,
            {
                prompt: "Which note under workspace:///notes/ mentions irrigation? Use a full-text lookup rather than opening the entries individually, and report its path.",
            },
            { signal: t.signal },
        );
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /alpha\.md/i, "the answer identifies the matching note");

        const finds = await s.db.test_log_entries_by_session_op_full.all<{ tx: string }>({
            session_id: modelSessionId,
            op: "FIND",
        });
        assert.ok(finds.some(({ tx }) => {
            const statement = JSON.parse(tx) as { matcher?: { dialect?: string } | null };
            return statement.matcher?.dialect === "fts";
        }), "the model used a full-text pattern rather than surveying entry bodies");
    } finally {
        await s.cleanup();
    }
});
