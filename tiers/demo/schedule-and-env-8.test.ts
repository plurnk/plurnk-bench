// {§tier-corpus} — deterministic `_plurnk` `{ rule, run }` schedule execution with zero model turns,
// `env://` scheme read/write, `$PLURNK_ENV` shell ingestion, and `&Symbol` Tree-sitter query.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initializeDemoRepository,
    liveLoop,
    liveTest as test,
    liveWorkspace,
    readBody,
    ResourceState,
    waitForDb,
} from "@plurnk/plurnk-service/harness";

test("demo: deterministic _plurnk schedule runs with 0 model turns, followed by env://, $PLURNK_ENV, and &Symbol query", async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-demo-schedule-env-8-"));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));

    await mkdir(join(projectRoot, "src"), { recursive: true });
    await writeFile(
        join(projectRoot, "src", "tariff.ts"),
        [
            "export const LEGACY_EPOCH = 1998;",
            "",
            "export function computeTariffWindow(baseHours: number): string {",
            '    return `WINDOW-${baseHours * 3}-HRS`;',
            "}",
            "",
            "export function unrelatedHelper(): number {",
            "    return 7;",
            "}",
            "",
        ].join("\n"),
    );
    initializeDemoRepository(projectRoot, "schedule env and symbol fixture");

    const s = await liveWorkspace({ name: `demo-schedule-env-8-${crypto.randomUUID()}`, projectRoot });
    try {
        // Phase 1: `_plurnk` deterministic `{ rule: "+1s", run }` obligation settles to `done` with ZERO model turns!
        const added = await s.invokeWorkspaceAction("workspace.schedule.add", {
            alias: "bootstrap-env",
            rule: "+1s",
            run: [
                { server: "plurnk", tool: "edit", arguments: { path: "env:///RELEASE_CHANNEL", text: "canary-8" } },
                { server: "plurnk", tool: "edit", arguments: { path: "workspace:///scheduled-stamp.txt", text: "tick-ok\n" } },
            ],
        }) as { status: number };
        assert.equal(added.status, 201);

        await waitForDb(
            async () => {
                const listed = await s.invokeWorkspaceAction("workspace.schedule.list", {}) as {
                    definitions: Array<{ alias: string; detail?: { status?: string } }>;
                };
                return listed.definitions.filter((d) => d.alias === "bootstrap-env" && d.detail?.status === "done");
            },
            (done) => done.length === 1,
            { timeoutMs: 10_000, intervalMs: 50 },
        );

        assert.equal(await readBody(s.db, "scheduled-stamp.txt"), "tick-ok\n", "_plurnk schedule wrote workspace:///scheduled-stamp.txt");
        const loopsAfterSchedule = await s.db.test_all_loops.all<{ id: number }>();
        const inferenceTurns = (
            await Promise.all(
                loopsAfterSchedule.map((l) => s.db.test_list_turns_in_loop.all<{ kind: string }>({ loop_id: l.id })),
            )
        )
            .flat()
            .filter(({ kind }) => kind === "inference");
        assert.equal(inferenceTurns.length, 0, "deterministic _plurnk schedule woke zero model inference turns");

        // Phase 2: One bounded model loop exercising `env://`, `$PLURNK_ENV`, and `&computeTariffWindow` symbol query!
        const loop = await liveLoop(
            s,
            2,
            {
                prompt: [
                    "1. Read `env:///RELEASE_CHANNEL`.",
                    "2. Run a shell command that appends `BUILD_STAMP=<RELEASE_CHANNEL>-verified` to the file at `$PLURNK_ENV` so it persists in your session environment.",
                    "3. Use a `&computeTariffWindow` symbol matcher (`read` or `find` with pattern `&computeTariffWindow`) on `src/tariff.ts` to inspect `computeTariffWindow`, and reply with both `BUILD_STAMP` and what `computeTariffWindow(4)` returns.",
                ].join("\n"),
                maxTurns: 10,
            },
            { signal: t.signal },
        );

        assert.equal(loop.finalStatus, 200);
        assert.match(loop.lastContent, /canary-8-verified/, "reply reports BUILD_STAMP=canary-8-verified");
        assert.match(loop.lastContent, /WINDOW-12-HRS/, "reply reports computeTariffWindow(4) === WINDOW-12-HRS");

        // Verify session-scoped `$PLURNK_ENV` ingestion (`BUILD_STAMP` in session env, absent from workspace env).
        const sessionEnv = await s.daemon.invokeModuleAction(
            "session.env.list",
            {},
            { scope: "session", workspaceId: s.workspaceId, sessionId: loop.modelSessionId },
        ) as { definitions: Array<{ alias: string; origin?: string; definition?: unknown }> };
        const buildStamp = sessionEnv.definitions.find((d) => d.alias === "BUILD_STAMP");
        assert.ok(buildStamp, `BUILD_STAMP persisted into session env via $PLURNK_ENV: ${JSON.stringify(sessionEnv.definitions)}`);

        const wsEnv = await s.invokeWorkspaceAction("workspace.env.list", {}) as {
            definitions: Array<{ alias: string }>;
        };
        assert.equal(wsEnv.definitions.some((d) => d.alias === "RELEASE_CHANNEL"), true);
        assert.equal(wsEnv.definitions.some((d) => d.alias === "BUILD_STAMP"), false, "$PLURNK_ENV stays session-scoped");

        // Verify `&computeTariffWindow` Tree-sitter symbol matcher was dispatched!
        const readRows = await s.db.test_log_entries_by_session_op_full.all<{ tx: string; status_rx: number }>({
            session_id: loop.modelSessionId,
            op: "read",
        });
        const findRows = await s.db.test_log_entries_by_session_op_full.all<{ tx: string; status_rx: number }>({
            session_id: loop.modelSessionId,
            op: "find",
        });
        const usedSymbolMatcher = [...readRows, ...findRows].some(
            ({ tx, status_rx }) => status_rx === 200 && tx.includes('"dialect":"graph"') && tx.includes("&computeTariffWindow"),
        );
        assert.equal(usedSymbolMatcher, true, "model executed a 200 Tree-sitter symbol matcher query on computeTariffWindow");
        assert.deepEqual(await ResourceState.check(s.db), []);
    } finally {
        await s.cleanup();
    }
});
