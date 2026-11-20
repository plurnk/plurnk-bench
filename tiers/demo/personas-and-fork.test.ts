// {§tier-corpus} — conventional `.agents/personas/<name>/PERSONA.md` discovery (`persona://`),
// persona-bound child delegation (`work` with `persona`), and history-inheriting session branching (`fork`).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    initializeDemoRepository,
    liveLoop,
    liveTest as test,
    liveWorkspace,
    ResourceState,
} from "@plurnk/plurnk-service/harness";

test("demo: discovered PERSONA.md governs a delegated child session and survives a forked branch session", async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-demo-personas-fork-"));
    t.after(() => rm(projectRoot, { recursive: true, force: true }));

    await mkdir(join(projectRoot, ".agents", "personas", "auditor"), { recursive: true });
    await writeFile(
        join(projectRoot, ".agents", "personas", "auditor", "PERSONA.md"),
        [
            "---",
            "name: auditor",
            "description: Security invariant auditor that stamps every report with AUDIT-SEAL-77.",
            "---",
            "Include the exact token `AUDIT-SEAL-77` in every final answer you send.",
            "",
        ].join("\n"),
    );
    await writeFile(
        join(projectRoot, "service.conf"),
        "MAX_CONNECTIONS=256\nTLS_MIN_VERSION=1.3\n",
    );
    initializeDemoRepository(projectRoot, "persona and fork fixture");

    const s = await liveWorkspace({ name: `demo-personas-fork-${crypto.randomUUID()}`, projectRoot });
    let forkedSessionId = -1;
    try {
        const personas = await s.daemon.listPersonas({ workspaceId: s.workspaceId });
        assert.ok(
            personas.some((p) => p.name === "auditor"),
            `discovered auditor persona from .agents/personas/auditor/PERSONA.md: ${JSON.stringify(personas)}`,
        );

        const result = await liveLoop(
            s,
            2,
            {
                prompt: [
                    "1. Delegate a child session named `audit-base` using the `auditor` persona to read `service.conf` and report both settings.",
                    "2. Once `audit-base` replies, fork a branch session named `audit-branch` from `session://audit-base` to answer what `MAX_CONNECTIONS` doubled would be without rereading `service.conf`.",
                    "3. Report both `audit-base`'s exact reply (preserving its seal token) and `audit-branch`'s doubled value.",
                ].join("\n"),
                maxTurns: 18,
            },
            { signal: t.signal },
        );

        assert.equal(result.finalStatus, 200, "parent orchestration loop finished cleanly");
        assert.match(result.lastContent, /AUDIT-SEAL-77/, "auditor persona seal reached the parent's report");
        assert.match(result.lastContent, /\b512\b/, "forked branch computed 256 * 2 = 512");

        const sessions = await s.daemon.listSessions(s.workspaceId);
        const delegated = sessions.find((sess) => sess.name === "audit-base" || (sess.kind === "work" && sess.persona === "auditor"));
        assert.ok(delegated, `delegated auditor session exists: ${JSON.stringify(sessions)}`);
        assert.equal(delegated.persona, "auditor", "delegated child persisted persona='auditor'");

        const forked = sessions.find((sess) => sess.kind === "fork" || sess.name === "audit-branch");
        assert.ok(forked, `forked branch session exists: ${JSON.stringify(sessions)}`);
        assert.equal(forked.persona, "auditor", "forked session inherited persona='auditor' from its source session");
        forkedSessionId = forked.id;
        assert.deepEqual(await ResourceState.check(s.db), []);
    } finally {
        await s.cleanup();
    }
    const { readFile } = await import("node:fs/promises");
    const digest = JSON.parse(await readFile(join(s.runDir, "digest", "digest.json"), "utf8")) as {
        log_entries?: Array<{ session_id: number; inherited_history?: boolean }>;
    };
    assert.ok(
        (digest.log_entries ?? []).some((row) => row.session_id === forkedSessionId && row.inherited_history === true),
        "forked session carries inherited_history=true log entries in digest",
    );
});
