// {§tier-corpus} — real-network HTTP scheme probe (`@plurnk/plurnk-schemes-http`) with zero model turns.
import assert from "node:assert/strict";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import {
    DEFAULT_MIMETYPES,
    Engine,
    fixtureExecutors,
    insertLoop,
    insertSession,
    insertTurn,
    insertWorkspace,
    liveTest as test,
    openMigrated,
    SchemeRegistry,
} from "@plurnk/plurnk-service/harness";

const HTTP_URL = "https://www.google.com/robots.txt";

test("{§tier-corpus} network web: a discovered http:// READ atomically materializes a real URL (no model, no mock)",
    { requires: [`url:${HTTP_URL}`] },
    async () => {
        const source = `plurnk.read({ path: ${JSON.stringify(HTTP_URL)} })`;
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items.find((i: { kind: string; statement?: PlurnkStatement }) => i.kind === "statement" && i.statement?.op === "read") as { statement: PlurnkStatement } | undefined;
        if (item === undefined) throw new Error("parse produced no statement");
        const statement = item.statement;
        const db = await openMigrated();
        const schemes = new SchemeRegistry();
        try {
            await schemes.discoverExternal(process.cwd());
            const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
            const workspaceId = await insertWorkspace(db, `web-http-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "web");
            const turnId = await insertTurn(db, loopId, 1, 102);

            const r = await engine.dispatch({ statement, workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "model" });
            assert.equal(r.status, 200, "finite HTTP READ settles only after canonical materialization");
            assert.match(String(r.content), /User-agent|Disallow/i, "READ returns the actual robots.txt content");
            const entry = await db.test_get_entry_by_pathname_scheme.get<{ id: number; authority: string }>({ scheme: "https", pathname: "/robots.txt" })
                ?? await db.test_get_entry_by_pathname_scheme.get<{ id: number; authority: string }>({ scheme: "http", pathname: "/robots.txt" });
            assert.ok(entry, "the READ atomically materialized one canonical entry under the served scheme");
            assert.equal(entry.authority, "www.google.com", "the entry's authority is the origin host");
            const body = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
            assert.ok(body?.content.startsWith(String(r.content)), "READ projects from the stored canonical prefix");
            assert.ok((body?.content.split("\n").length ?? 0) > 100, "the entry retains a page far longer than a hundred lines");
            const range = r.range as { total?: number; returned?: readonly number[] } | undefined;
            const page = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES);
            assert.deepEqual(range?.returned, [1, Math.min(page, range?.total ?? -1)], "the first page, at most the panel's preview lines");
        } finally {
            await schemes.close();
            await db.close();
        }
    });
