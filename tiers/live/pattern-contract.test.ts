import assert from "node:assert/strict";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { liveLoop, liveWorkspace, readBody, seedEntry } from "@plurnk/plurnk-service/harness";

test("live: full-text READ answers from the selected source lines", async (t) => {
    const s = await liveWorkspace({ name: `live-pattern-fulltext-read-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "maintenance.md", content: "The database backup runs on Sunday.\nThe irrigation check runs on Tuesday.\nThe fire alarm test runs on Friday." });
        const loop = await liveLoop(s, 2, {
            prompt: "Use a full-text pattern on a READ of workspace:///maintenance.md to find the irrigation check. On which day does it run?",
        }, { signal: t.signal });
        assert.equal(loop.finalStatus, 200);
        assert.match(loop.lastContent, /Tuesday/);
        const reads = await s.db.test_log_entries_by_session_op_full.all<{ origin: string; tx: string; status_rx: number }>({ session_id: loop.modelSessionId, op: "READ" });
        const selected = reads.filter(({ origin, tx }) => origin === "model" && JSON.parse(tx).matcher?.dialect === "fts");
        assert.ok(selected.length > 0, "the model exercised full-text READ");
        assert.ok(selected.every(({ status_rx }) => status_rx === 200), JSON.stringify(selected));
    } finally { await s.cleanup(); }
});

test("live: structural edits preserve neighboring source text", async (t) => {
    const s = await liveWorkspace({ name: `live-pattern-structural-edit-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "catalog.xml", content: '<root><item id="old">A</item><other>B</other></root>', mimetype: "application/xml" });
        await seedEntry(s.db, s.workspaceId, { pathname: "config.json", content: '{"host":"old","port":80}', mimetype: "application/json" });
        const loop = await liveLoop(s, 2, {
            prompt: "In workspace:///catalog.xml, use XPath to change the item id to new and its text to C. In workspace:///config.json, use JSONPath to change host to db.example. Preserve all other source text exactly.",
        }, { signal: t.signal });
        assert.equal(loop.finalStatus, 200);
        assert.equal(await readBody(s.db, "catalog.xml"), '<root><item id="new">C</item><other>B</other></root>');
        assert.equal(await readBody(s.db, "config.json"), '{"host":"db.example","port":80}');
        const edits = await s.db.test_log_entries_by_session_op_full.all<{ tx: string; status_rx: number }>({ session_id: loop.modelSessionId, op: "EDIT" });
        assert.ok(edits.length > 0);
        assert.ok(edits.every(({ status_rx }) => status_rx === 200), JSON.stringify(edits));
        const dialects = new Set(edits.map(({ tx }) => JSON.parse(tx).matcher?.dialect));
        assert.ok(dialects.has("xpath") && dialects.has("jsonpath"), "the model exercised both structural selectors");
    } finally { await s.cleanup(); }
});
