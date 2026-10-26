// Storyline demo: write a small script, then run it, then report what
// came out. This is the canonical "create artifact + execute it"
// workflow — common across real assistant interactions.
//
// User-facing prompt is natural: no operation syntax, no
// mention of `exec:///` or file conventions. Pure intent.
//
// Driven through the REAL prod loop (loop.run via the daemon). workspace.create
// pins the workspace as project_root, so filesystem work lands there and execution
// defaults there — the model finds what it just wrote, with no hand-wired engine.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";
import { initializeDemoRepository } from "@plurnk/plurnk-service/harness";
import { observedScriptExecution, type ScriptReceipt } from "./_script-oracle.ts";

test("demo: 'write a script that greets me and run it' — script lands in workspace, runs, model reports the greeting", async (t) => {
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-demo-script-"));
    try {
        // Git membership gives the model an ordinary writable project workspace.
        initializeDemoRepository(workspace, "fixture", false);
        const s = await liveWorkspace({ name: `demo-script-${crypto.randomUUID()}`, projectRoot: workspace });
        try {
            const marker = "DEMO-GREETING-9F3A";
            const userPrompt = `Write a POSIX shell script file named greet.sh in the project directory that prints the line "${marker}", then run that file and tell me what it printed.`;
            const { finalStatus, turnIds, lastContent } = await liveLoop(s, 2, { prompt: userPrompt }, { signal: t.signal });

            if (finalStatus !== 200) {
                for (const turnId of turnIds) {
                    const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
                    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                    console.error(`turn ${turnId} status=${row?.status}: ${(packet.assistant?.content ?? "").slice(0, 400)}`);
                }
            }

            // Outcome assertions:
            //   1. The script file the model wrote lives in the workspace.
            const scriptContent = await readFile(join(workspace, "greet.sh"), "utf8");
            assert.match(scriptContent, new RegExp(marker), "script body contains the marker");

            // Execution may be delegated; receipts are paired within their owning session.
            const sessions = await s.db.test_sessions_by_workspace.all<{ id: number }>({ workspace_id: s.workspaceId });
            const observed = await Promise.all(sessions.map(async ({ id }) => observedScriptExecution(
                await s.db.test_log_entries_by_session_op_full.all<ScriptReceipt>({ session_id: id, op: "sh" }),
                await s.db.test_log_entries_by_session_op_full.all<ScriptReceipt>({ session_id: id, op: "READ" }),
                "greet.sh", marker,
            )));
            assert.ok(observed.some(Boolean), "an execution of greet.sh produced the greeting in an observed successful stdout receipt");

            assert.equal(finalStatus, 200, "loop terminated cleanly");
            assert.match(lastContent, new RegExp(marker),
                `final reply contains the marker the script printed; got: ${lastContent.slice(0, 200)}`);
        } finally { await s.cleanup(); }
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
