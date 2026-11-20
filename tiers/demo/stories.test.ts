// Multi-step and oracle-verified storyline demos against a seeded project fixture ({§tier-corpus}).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    failAfterCleanup,
    liveLoop,
    liveTest as test,
    liveWorkspace,
    ResourceState,
    seedDemoFixture,
    type Db,
    type LiveWorkspace,
} from "@plurnk/plurnk-service/harness";
import { hasAuditOutcome } from "./_audit-oracle.ts";
import { assertSingleProseParagraph } from "./_authoring-oracle.ts";
import { latestStableNodeVersion, versionsNamed } from "./_web-oracle.ts";

interface StoryOpts {
    signal: AbortSignal;
    label: string;
    prompt: string;
    maxTurns?: number;
    setup?: (workspace: LiveWorkspace) => Promise<void>;
}

interface StoryResult {
    db: Db;
    workspace: string;
    cleanup: () => Promise<void>;
    turnIds: number[];
    modelSessionId: number;
    finalStatus: number;
    lastContent: string;
    dump: () => Promise<void>;
}

const runStory = async (opts: StoryOpts): Promise<StoryResult> => {
    const fixture = await seedDemoFixture(opts.label);
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `demo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        await opts.setup?.(s);
        const loop = await liveLoop(
            s,
            2,
            { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) },
            { signal: opts.signal },
        );
        const { finalStatus, hitMaxTurns, turnIds, modelSessionId, lastContent } = loop;
        console.error(`[story:${opts.label}] turns=${turnIds.length} finalStatus=${finalStatus} hitMaxTurns=${hitMaxTurns}`);
        const wsViolations = await ResourceState.check(s.db);
        assert.deepEqual(wsViolations, [], `[story:${opts.label}] the workspace stays lawful after the story`);

        const dump = async (): Promise<void> => {
            for (const turnId of turnIds) {
                const row = await s.db.test_get_turn.get<{ packet: string; status: number }>({ id: turnId });
                const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
                console.error(`--- turn ${turnId} status=${row?.status} ---`);
                console.error((packet.assistant?.content ?? "").slice(0, 2000));
            }
        };

        return {
            db: s.db,
            workspace: fixture.workspace,
            cleanup,
            turnIds,
            modelSessionId,
            finalStatus,
            lastContent,
            dump,
        };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

const BRAVE_SEARCH = { alias: "brave", type: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server@2.1.0"] };
const addMcp = (definition: { readonly alias: string } & Readonly<Record<string, unknown>>) => async (workspace: LiveWorkspace): Promise<void> => {
    const added = await workspace.invokeWorkspaceAction("workspace.mcp.add", definition) as { status?: number };
    assert.equal(added.status, 201, `the ${definition.alias} server is added and attached before the model loop`);
};

interface ChainOpts {
    signal: AbortSignal;
    label: string;
    prompts: string[];
    maxTurns?: number;
    onStep?: (index: number, workspace: string) => Promise<void>;
}
interface ChainStep {
    finalStatus: number;
    lastContent: string;
    turnIds: number[];
}
interface ChainResult {
    workspace: string;
    steps: ChainStep[];
    db: Db;
    cleanup: () => Promise<void>;
}

const runStoryChain = async (opts: ChainOpts): Promise<ChainResult> => {
    const fixture = await seedDemoFixture(opts.label);
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(fixture.cleanup);
    const cleanup = () => lifetime.disposeAsync();
    try {
        const s = await liveWorkspace({ name: `demo-${opts.label}-${crypto.randomUUID()}`, projectRoot: fixture.workspace });
        lifetime.defer(s.cleanup);
        const steps: ChainStep[] = [];
        let id = 2;
        for (const prompt of opts.prompts) {
            const loop = await liveLoop(
                s,
                id++,
                { prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) },
                { signal: opts.signal },
            );
            steps.push({ finalStatus: loop.finalStatus, lastContent: loop.lastContent, turnIds: loop.turnIds });
            console.error(`[chain:${opts.label}] step ${steps.length} turns=${loop.turnIds.length} finalStatus=${loop.finalStatus}`);
            if (opts.onStep !== undefined) await opts.onStep(steps.length - 1, fixture.workspace);
        }
        const chainViolations = await ResourceState.check(s.db);
        assert.deepEqual(chainViolations, [], `[chain:${opts.label}] the workspace stays lawful after the chain`);
        return { workspace: fixture.workspace, steps, db: s.db, cleanup };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

test("{§tier-corpus} story: answer a current question with search MCP available", { requires: ["env:BRAVE_API_KEY"] }, async (t) => {
    const index = await fetch("https://nodejs.org/dist/index.json", {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(30_000)]),
    });
    assert.equal(index.status, 200, "the independent Node release oracle is available before model spend");
    const expectedVersion = latestStableNodeVersion(await index.json());
    console.error(`[story:web-search-mcp] oracle=${expectedVersion} source=https://nodejs.org/dist/index.json`);
    const story = await runStory({
        signal: t.signal,
        label: "web-search-mcp",
        prompt: "Search the web for the newest non-prerelease Node.js release. Tell me its full major.minor.patch version in one sentence.",
        maxTurns: 8,
        setup: addMcp(BRAVE_SEARCH),
    });
    try {
        const rows = (await Promise.all(story.turnIds.map((turnId) =>
            story.db.test_log_entries_by_turn.all<{ op: string | null; scheme: string | null; status_rx: number; rx: string }>({ turn_id: turnId }),
        ))).flat();
        const INTERNAL = new Set(["session", "skill", "log", "reasoning", "ops", "note", "message"]);
        const retrievedRows = rows.filter((row) =>
            (row.op === "read" || row.op === "brave")
            && (row.status_rx === 200 || row.status_rx === 413)
            && (row.op === "brave" || (row.scheme !== null && !INTERNAL.has(row.scheme))));
        const retrieved = versionsNamed(retrievedRows.map((row) => row.rx).join("\n"));
        const answered = versionsNamed(story.lastContent);
        const ok = story.finalStatus === 200 && [...answered].some((version) => retrieved.has(version));
        if (!ok) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.ok(retrievedRows.length > 0, "the model retrieved something external: search results, a web READ, or an execution's output");
        assert.ok(retrieved.size > 0, "the retrieved content names a Node version");
        assert.ok([...answered].some((version) => retrieved.has(version)),
            `the answer names a version the retrieved content carried (${[...retrieved].join(", ")}); got: ${story.lastContent.slice(0, 200)}`);
        if (!retrieved.has(expectedVersion)) console.error(`[story:web-search-mcp] the search backend lags the release index: results named ${[...retrieved].join(", ")}; the index says ${expectedVersion}`);
    } finally {
        await story.cleanup();
    }
});

test("story: self-audit — the model critiques its own packet for errors and ambiguities", { timeout: 1_800_000 }, async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "packet-audit",
        prompt: "I am evaluating my agent interface. Please evaluate the instructions and information in this packet for errors, issues, inconsistencies, and ambiguities. The interface instructions remain in effect for this response: conclude with your findings listed numerically.",
    });
    try {
        console.error("\n===== PACKET SELF-AUDIT FINDINGS =====");
        console.error(story.lastContent);
        console.error("===== END SELF-AUDIT =====\n");
        assert.equal(story.finalStatus, 200, "the audit loop concludes cleanly");
        assert.ok(hasAuditOutcome(story.lastContent), `the audit must list a numbered finding or explicitly report none; got: ${story.lastContent.slice(0, 200)}`);
    } finally {
        await story.cleanup();
    }
});

test("story: draft a brief, tighten it, then file it away", async (t) => {
    const sizes: number[] = [];
    const chain = await runStoryChain({
        signal: t.signal,
        label: "authoring",
        maxTurns: 10,
        prompts: [
            "Write me a short brief — two or three paragraphs — on why the printing press changed the world, and save it as brief.md.",
            "That's longer than I need. Cut it down to a single tight paragraph.",
            "Perfect. Now move brief.md into a drafts/ folder to keep my workspace tidy.",
        ],
        onStep: async (i, ws) => {
            if (i <= 1) sizes[i] = (await readFile(join(ws, "brief.md"), "utf8").catch(() => "")).trim().length;
        },
    });
    try {
        assert.ok(sizes[0] > 200, `the draft has substantial prose; got ${sizes[0]} chars`);
        assert.ok(sizes[1] > 0 && sizes[1] < sizes[0], `the refined brief is shorter (${sizes[1]} < ${sizes[0]} chars)`);
        const inDrafts = await readFile(join(chain.workspace, "drafts", "brief.md"), "utf8").catch(() => null);
        assert.ok(inDrafts !== null, "brief.md was relocated under drafts/");
        assert.equal(inDrafts.trim().length, sizes[1], "the relocated file is the refined brief");
        assertSingleProseParagraph(inDrafts);
        const atRoot = await readFile(join(chain.workspace, "brief.md"), "utf8").catch(() => null);
        assert.equal(atRoot, null, "the move left no brief.md at the workspace root");
    } finally {
        await chain.cleanup();
    }
});

test("story: compute a value too big for arithmetic shortcuts", async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "compute",
        prompt: "What's 25 factorial?",
        maxTurns: 6,
    });
    try {
        const wanted = /15,?511,?210,?043,?330,?985,?984,?000,?000/;
        if (story.finalStatus !== 200 || !wanted.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, wanted, `computed 25! exactly; got: ${story.lastContent.slice(0, 200)}`);
    } finally {
        await story.cleanup();
    }
});

test("{§tier-corpus}: create and revise a decisions document without fragmenting identity", async (t) => {
    const chain = await runStoryChain({
        signal: t.signal,
        label: "resource-state-edit",
        prompts: [
            "Create a new file docs/decisions.md that lists exactly two architecture decisions as bullet points: we use express, and we use sqlite.",
            "In docs/decisions.md, change the sqlite decision to postgres. Leave the express one alone.",
            "Read docs/decisions.md and tell me both decisions in one sentence.",
        ],
    });
    try {
        for (const [i, step] of chain.steps.entries()) {
            assert.equal(step.finalStatus, 200, `step ${i + 1} concluded`);
        }
        const onDisk = await readFile(join(chain.workspace, "docs/decisions.md"), "utf8");
        assert.match(onDisk, /express/i, "the surviving decision is on disk");
        assert.match(onDisk, /postgres/i, "the revision landed on disk");
        assert.doesNotMatch(onDisk, /sqlite/i, "the revised decision is gone");
        assert.match(chain.steps[2].lastContent, /express/i, "the model reports its own work");
        assert.match(chain.steps[2].lastContent, /postgres/i);
        const row = await chain.db.test_count_rows_for_pathname.get<{ n: number }>({ pathname: "docs/decisions.md" });
        assert.equal(row?.n, 1, "the created file has exactly one durable identity");
    } finally {
        await chain.cleanup();
    }
});
