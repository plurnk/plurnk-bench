// {§tier-corpus} — headless workspace (`projectRoot: null`): workspace:/// and session:// storage,
// shell execution in ephemeral scratch, and zero `file://` member projection.
import assert from "node:assert/strict";
import { liveLoop, liveTest as test, liveWorkspace, readBody, ResourceState, seedEntry } from "@plurnk/plurnk-service/harness";

test("live: headless workspace operates with projectRoot=null over workspace:/// and shell without file:// members", async (t) => {
    const s = await liveWorkspace({ name: `live-headless-${crypto.randomUUID()}`, projectRoot: null });
    try {
        const listed = await s.daemon.listWorkspaces();
        const created = listed.find((ws) => ws.id === s.workspaceId);
        assert.ok(created, "headless workspace is listed");
        assert.equal(created.project_root, null, "project_root remains null in SQLite");

        await seedEntry(s.db, s.workspaceId, { pathname: "brief.md", content: "TOKEN=HEADLESS-804\n" });
        const result = await liveLoop(
            s,
            2,
            {
                prompt: "Read `workspace:///brief.md`, run a shell command that prints the SHA-256 hex digest of the exact string `HEADLESS-804` (without a newline), write that 64-character hex digest to `workspace:///digest.txt`, and reply with the digest.",
                maxTurns: 8,
            },
            { signal: t.signal },
        );
        assert.equal(result.finalStatus, 200);
        // SHA-256("HEADLESS-804") = 9c0c... compute in Node as independent oracle!
        const { createHash } = await import("node:crypto");
        const expectedHex = createHash("sha256").update("HEADLESS-804").digest("hex");
        assert.match(result.lastContent, new RegExp(expectedHex, "i"), "reply reports the computed SHA-256 hex digest");
        assert.equal((await readBody(s.db, "digest.txt"))?.trim().toLowerCase(), expectedHex, "workspace:///digest.txt holds the digest");

        const fileRows = await s.db.test_log_entries_by_session_op_full.all<{ scheme: string | null }>({
            session_id: result.modelSessionId,
            op: "read",
        });
        assert.equal(
            fileRows.some(({ scheme }) => scheme === "file"),
            false,
            "headless workspace never materializes file:// reads",
        );
        assert.deepEqual(await ResourceState.check(s.db), []);
    } finally {
        await s.cleanup();
    }
});
