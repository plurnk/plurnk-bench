// Auto-add with a real model ({§tier-corpus}): the model is asked about
// a generated file git does not track, READs it, and the read admits it as the model's own definition
// of that path, announced by one member_added notice; it answers from what it read. Read friction
// first: any refused operation is a failure, a shell detour around membership is a failure, and the
// admission must carry the model's provenance, even when the final number is right.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";
import { seedDemoFixture } from "@plurnk/plurnk-service/harness";
import { failAfterCleanup } from "@plurnk/plurnk-service/harness";
import { ResourceState } from "@plurnk/plurnk-service/harness";

interface LogRow { op: string | null; origin: string; status_rx: number; rx: string; tx: string }
interface Definition { alias: string; origin: string; state: string; definition?: { glob?: string; provenance?: { kind?: string } } }

const REPORT = "build/report.json";

test("members: a READ of an untracked file admits it as the model's own definition, with a notice, and the model answers from it", { timeout: 600_000 }, async (t) => {
    const fixture = await seedDemoFixture("members-miss");
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        // Generated after the fixture's commit: on disk, untracked, not ignored, so not a member.
        await mkdir(join(fixture.workspace, "build"), { recursive: true });
        await writeFile(join(fixture.workspace, REPORT), JSON.stringify({ coverage: 87, failures: 0 }, null, 2) + "\n");
        const s = await liveWorkspace({ name: `demo-members-miss-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const loop = await liveLoop(s, 2, {
            prompt: `What coverage percentage does ${REPORT} record? It is generated output and is not committed. Reply with just the number.`,
            maxTurns: 8,
        }, { signal: t.signal });
        const rows = await s.db.engine_render_log.all<LogRow>({ session_id: loop.modelSessionId });
        const targetOf = (row: LogRow): string => { try { return (JSON.parse(row.tx) as { target?: { raw?: string } }).target?.raw ?? ""; } catch { return ""; } };
        const problemOf = (row: LogRow): { type?: string; recovery?: string } => { try { return (JSON.parse(row.rx) as { problem?: { type?: string; recovery?: string } }).problem ?? {}; } catch { return {}; } };

        // Friction first: nothing is refused, and the file is read through membership, not around it.
        const refused = rows.filter((row) => row.origin === "model" && row.status_rx >= 400);
        assert.deepEqual(refused.map((row) => `${row.op} ${row.status_rx} ${targetOf(row)} ${problemOf(row).type ?? ""}`), [], "no operation was refused");
        const operations = rows.filter((row) => row.origin === "model").map((row) => `${row.op} ${targetOf(row)}`);
        assert.ok(operations.some((operation) => operation.startsWith("READ ") && operation.endsWith(REPORT)), `the model READ ${REPORT}; operations ${JSON.stringify(operations)}`);
        assert.ok(!operations.some((operation) => operation.startsWith("sh ")), `the model did not detour around membership through the shell; operations ${JSON.stringify(operations)}`);
        assert.deepEqual(await ResourceState.check(s.db), [], "the workspace stays lawful");

        // The read admitted it: a workspace definition of the model's own, and a member, announced once.
        const { definitions } = await s.invokeWorkspaceAction("workspace.members.list", {}) as { definitions: Definition[] };
        const admitted = definitions.find(({ alias }) => alias === REPORT);
        assert.ok(admitted, `the READ admitted ${REPORT}; definitions ${JSON.stringify(definitions.map(({ alias }) => alias))}`);
        assert.equal(admitted.origin, "workspace");
        assert.equal(admitted.definition?.provenance?.kind, "model-proposal", "the admission carries the model's provenance");
        assert.equal(admitted.state, "active");
        const member = await s.db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: s.workspaceId, scheme: "file", authority: "", pathname: REPORT });
        assert.ok(member, "the generated file became a member");
        const packets = await Promise.all(loop.turnIds.map((id) => s.db.test_get_packet.get<{ packet: string }>({ id })));
        assert.ok(packets.some((row) => row?.packet?.includes("[member_added]") === true), "the member_added notice reached a packet");

        assert.equal(loop.finalStatus, 200, "the loop concluded");
        assert.match(loop.lastContent, /\b87\b/u, "the answer is the number the file records");
        await cleanup();
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
});
