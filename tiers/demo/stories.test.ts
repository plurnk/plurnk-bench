// Storyline demos against a seeded project fixture. Each test is a
// natural user prompt — no syntax hints, no mention of execution/EDIT/READ.
// The model navigates real files (notes.md, src/config.json,
// src/app.js, data/users.json, package.json) and we assert outcomes:
// file content after edit, response text after query, etc.
//
// Driven through the REAL prod loop — loop.run via the daemon. workspace.create
// pins the fixture as project_root; PLURNK_SERVICE_GIT_AUTO makes its git-committed
// files members the production way (no hand-registered catalog), and Exec
// defaults its cwd to project_root. runStory boots the prod Daemon directly
// (rather than the auto-closing withDaemon) only because the db must stay open
// for the post-loop forensic asserts; the loop itself is 100% prod.
//
// Model-story doctrine:
//   - Project fixture: real files the model can read/edit/query.
//   - Scoped prompts: "find exactly N values" / "edit this specific
//     thing" — gives weaker models a clear stopping point. Open-ended phrasings
//     let small models over-investigate and stall on Completion.
//   - The configurable timeout leaves room for multi-step local-model reasoning.
//   - Assertions target task outcomes and named behavioral invariants, not incidental exact OP sequences.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "@plurnk/plurnk-service/harness";
import { liveWorkspace, liveLoop, type LiveWorkspace } from "@plurnk/plurnk-service/harness";
import { seedDemoFixture } from "@plurnk/plurnk-service/harness";
import { latestStableNodeVersion, versionsNamed } from "./_web-oracle.ts";
import { hasAuditOutcome } from "./_audit-oracle.ts";
import { failAfterCleanup } from "@plurnk/plurnk-service/harness";
import { ResourceState } from "@plurnk/plurnk-service/harness";
import type { CapabilityPolicy } from "@plurnk/plurnk-contracts";

interface StoryOpts {
    signal: AbortSignal;
    label: string;
    prompt: string;
    maxTurns?: number;
    capabilities?: CapabilityPolicy;
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
        if (opts.capabilities !== undefined) await s.daemon.setWorkspaceCapabilities({ workspaceId: s.workspaceId, policy: opts.capabilities });
        lifetime.defer(s.cleanup);
        await opts.setup?.(s);
        const loop = await liveLoop(
            s, 2,
            { prompt: opts.prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) },
            { signal: opts.signal },
        );
        const { finalStatus, hitMaxTurns, turnIds, modelSessionId, lastContent } = loop;
        console.error(`[story:${opts.label}] turns=${turnIds.length} finalStatus=${finalStatus} hitMaxTurns=${hitMaxTurns}`);
        // {§test-artifact-retention} — every demo story also audits the workspace the model leaves behind.
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
            db: s.db, workspace: fixture.workspace,
            cleanup,
            turnIds, modelSessionId, finalStatus, lastContent, dump,
        };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

// {§mcp-configuration} {§mcp-launch-environment}
const BRAVE_SEARCH = { name: "brave", type: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server@2.1.0"] };
const addMcp = (definition: { readonly name: string }) => async (workspace: LiveWorkspace): Promise<void> => {
    const added = await workspace.invokeWorkspaceAction("workspace.mcp.add", { definition }) as { status?: number };
    assert.equal(added.status, 201, `the ${definition.name} server is added and attached before the model loop`);
};

interface ChainOpts { signal: AbortSignal; label: string; prompts: string[]; maxTurns?: number; onStep?: (index: number, workspace: string) => Promise<void>;
}
interface ChainStep { finalStatus: number; lastContent: string; turnIds: number[]; }
interface ChainResult { workspace: string; steps: ChainStep[]; db: Db; cleanup: () => Promise<void>; }

// Multi-prompt story: ONE workspace, prompts fired in sequence (each its own loop.run), so
// workspace state persists — the model works with its OWN prior output across turns (an authored
// file it must re-READ and revise, a fact it must recall). Same fixture + teardown discipline as
// runStory: a liveLoop throw lands before the caller holds the result, so tear down here.
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
                s, id++,
                { prompt, ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}) },
                { signal: opts.signal },
            );
            steps.push({ finalStatus: loop.finalStatus, lastContent: loop.lastContent, turnIds: loop.turnIds });
            console.error(`[chain:${opts.label}] step ${steps.length} turns=${loop.turnIds.length} finalStatus=${loop.finalStatus}`);
            if (opts.onStep !== undefined) await opts.onStep(steps.length - 1, fixture.workspace);
        }
        // {§test-artifact-retention} — the chain leaves a lawful workspace, audited like every story.
        const chainViolations = await ResourceState.check(s.db);
        assert.deepEqual(chainViolations, [], `[chain:${opts.label}] the workspace stays lawful after the chain`);
        return { workspace: fixture.workspace, steps, db: s.db, cleanup };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

const assertSingleProseParagraph = (markdown: string): void => {
    const prose = markdown.trim().replace(/^#{1,6}[\t ]+[^\r\n]+(?:\r\n|\n|\r)+/, "").trim();
    assert.ok(prose.length > 0, "the refined brief retains prose after an optional heading");
    assert.doesNotMatch(prose, /(?:\r\n|\n|\r)[\t ]*(?:\r\n|\n|\r)/, "the refined brief has one prose paragraph");
};

test("authoring oracle permits an optional heading without permitting a second prose paragraph", () => {
    assert.doesNotThrow(() => assertSingleProseParagraph("# Printing Press\n\nOne tight paragraph."));
    assert.throws(
        () => assertSingleProseParagraph("# Printing Press\n\nFirst paragraph.\n\nSecond paragraph."),
        /one prose paragraph/,
    );
});

test("story: find a single value in a JSON config", async (t) => {
    // src/config.json has { db, pool, host }. Scoped prompt: ONE value.
    // A single-value question gives the model a crisp completion boundary;
    // open-ended phrasing invites unrelated investigation.
    const story = await runStory({
        signal: t.signal,
        label: "config-lookup",
        prompt: "What database host does src/config.json use?",
    });
    try {
        if (story.finalStatus !== 200 || !/db\.internal/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /db\.internal/,
            `final reply contains the host value; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("{§membership} story: answer a current question with search MCP available", { requires: ["env:BRAVE_API_KEY"] }, async (t) => {
    // The attachment provides an option, not an oracle requirement. The independent
    // release index is never injected into the model's prompt or workspace.
    const index = await fetch("https://nodejs.org/dist/index.json", {
        signal: AbortSignal.any([t.signal, AbortSignal.timeout(30_000)]),
    });
    assert.equal(index.status, 200, "the independent Node release oracle is available before model spend");
    const expectedVersion = latestStableNodeVersion(await index.json());
    console.error(`[story:web-search-mcp] oracle=${expectedVersion} source=https://nodejs.org/dist/index.json`);
    const story = await runStory({
        signal: t.signal,
        label: "web-search-mcp",
        prompt: "Search the web for the newest non-prerelease Node.js release (Current, not LTS). Tell me its full major.minor.patch version in one sentence.",
        maxTurns: 8,
        setup: addMcp(BRAVE_SEARCH),
    });
    try {
        // {§membership} — graded on retrieval by any first-class route (#828): search MCP results,
        // a direct READ, or an execution's output the model observed. The answer names a version that
        // retrieved content carried; the release index is information, the backend's crawl lag is not the model's.
        const rows = (await Promise.all(story.turnIds.map((turnId) =>
            story.db.test_log_entries_by_turn.all<{ op: string | null; scheme: string | null; status_rx: number; rx: string }>({ turn_id: turnId }),
        ))).flat();
        const INTERNAL = new Set(["session", "skill", "log", "reasoning", "ops", "note", "message"]);
        const retrievedRows = rows.filter((row) => row.op === "READ" && row.status_rx === 200 && row.scheme !== null && !INTERNAL.has(row.scheme));
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
    } finally { await story.cleanup(); }
});

// The prompt never says to search: the model has to notice the question is past its knowledge and
// retrieve, so the search server is a requirement of the story, not an option.
test("story: answer a recent general-knowledge question", { requires: ["env:BRAVE_API_KEY"] }, async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "web-retrieve-live",
        prompt: "As of August 20, 2026, who won the 2026 Eurovision Song Contest, and with which song?",
        maxTurns: 30,
        setup: addMcp(BRAVE_SEARCH),
    });
    try {
        const ok = story.finalStatus === 200
            && /DARA/i.test(story.lastContent)
            && /Bangaranga/i.test(story.lastContent);
        if (!ok) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /DARA/i, `the answer identifies DARA; got: ${story.lastContent.slice(0, 200)}`);
        assert.match(story.lastContent, /Bangaranga/i, `the answer identifies Bangaranga; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: explain Markdown with nested code examples", async (t) => {
    const ending = "Examples are text, not commands.";
    const story = await runStory({
        signal: t.signal,
        label: "nested-code-examples",
        prompt: `Show me a Markdown source example that itself contains a fenced shell code block printing hello. Include a short explanation after the source example. Do not execute the example. End your answer with this exact sentence: ${ending}`,
    });
    try {
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /(?:echo|printf)[^\r\n]*hello/iu, "the response includes the requested command example");
        assert.match(story.lastContent, /(?:\x60{3,}|~{3,})/u, "the response demonstrates fencing");
        assert.ok(story.lastContent.trim().endsWith(ending), "the explanation after the nested example reaches the client");
    } finally { await story.cleanup(); }
});

test("story: read the codename from notes.md", async (t) => {
    const story = await runStory({
        signal: t.signal,
        label: "codename",
        prompt: "What's the project codename? It's in notes.md.",
    });
    try {
        if (story.finalStatus !== 200 || !/phoenix/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /phoenix/i,
            `final reply mentions the codename; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: self-audit — the model critiques its own packet for errors and ambiguities", async (t) => {
    // Meta-prompt (owner request): the model audits the packet it was handed, surfacing
    // instruction errors / inconsistencies / ambiguities neither the author nor the operator
    // sees from inside. Diagnostic, not pass/fail — the findings ARE the deliverable, so they
    // are always dumped to the test log for review.
    const story = await runStory({
        signal: t.signal,
        label: "packet-audit",
        // The meta framing invites a bare report; the last sentence corrects that credible
        // assumption — the interface still governs this response — and says where the list lands.
        prompt: "I am evaluating my agent interface. Please evaluate the instructions and information in this packet for errors, issues, inconsistencies, and ambiguities. The interface instructions remain in effect for this response: conclude with your findings listed numerically.",
    });
    try {
        console.error("\n===== PACKET SELF-AUDIT FINDINGS =====");
        console.error(story.lastContent);
        console.error("===== END SELF-AUDIT =====\n");
        assert.equal(story.finalStatus, 200, "the audit loop concludes cleanly");
        assert.ok(hasAuditOutcome(story.lastContent), `the audit must list a numbered finding or explicitly report none; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: edit a TODO comment in src/app.js", async (t) => {
    // app.js has `// TODO: add error handling`. Model replaces it with
    // an exact-text replacement and we verify on disk.
    const story = await runStory({
        signal: t.signal,
        label: "edit-todo",
        prompt: 'In src/app.js, replace the comment "// TODO: add error handling" with "// error handler configured". Read the file first if you need to.',
    });
    try {
        if (story.finalStatus !== 200) await story.dump();
        assert.equal(story.finalStatus, 200);
        const onDisk = await readFile(join(story.workspace, "src/app.js"), "utf8");
        assert.match(onDisk, /\/\/ error handler configured/,
            "new comment landed on disk");
        assert.doesNotMatch(onDisk, /\/\/ TODO: add error handling/,
            "old TODO comment removed");
    } finally { await story.cleanup(); }
});

test("story: pull just one line out of a file", async (t) => {
    // Natural prompt that benefits from READ <L>. The model may also read
    // the whole file and report the line; either way, the holistic outcome
    // (mentioning the line content) is what we assert. Line 2 of the
    // fixture's src/app.js is `const app = express();`.
    const story = await runStory({
        signal: t.signal,
        label: "one-line",
        prompt: "What's on line 2 of src/app.js?",
    });
    try {
        if (story.finalStatus !== 200 || !/express/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /express/,
            `final reply contains the line 2 content; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

// Structured matcher demos. The assertions pin the user-visible answer without
// prescribing whether the model uses JSONPath, XPath, another matcher, or a complete READ.

test("story: list every admin user from a JSON file", async (t) => {
    // data/users.json: [{name:Alice,role:admin}, {name:Bob,role:viewer}].
    // jsonpath path: $.[?(@.role=='admin')].name → ["Alice"]
    // Fallback paths: regex match on lines / execution / full READ + reason.
    const story = await runStory({
        signal: t.signal,
        label: "list-admins",
        prompt: "In data/users.json, who has the 'admin' role? List each admin's name.",
    });
    try {
        if (story.finalStatus !== 200 || !/Alice/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /Alice/,
            `final reply names the admin; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: extract all h1 headings from an HTML page", async (t) => {
    // data/users.html has one h1 "Team Roster".
    // xpath path: //h1/text() → ["Team Roster"]
    // Fallback: regex /<h1>(.+?)<\/h1>/ or full READ + visual parse.
    const story = await runStory({
        signal: t.signal,
        label: "html-headings",
        prompt: "What does the heading on data/users.html say?",
    });
    try {
        if (story.finalStatus !== 200 || !/Team Roster/i.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /Team Roster/i);
    } finally { await story.cleanup(); }
});

test("story: pull email addresses out of an HTML element's attribute", async (t) => {
    // data/users.html: <user email="alice@x.com">, <user email="bob@x.com">, <user email="carol@x.com">.
    // xpath path: //user/@email → ["alice@x.com", "bob@x.com", "carol@x.com"]
    const story = await runStory({
        signal: t.signal,
        label: "html-attrs",
        prompt: "List the email addresses for every user in data/users.html.",
    });
    try {
        if (story.finalStatus !== 200 || !/alice@x\.com/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /alice@x\.com/);
        assert.match(story.lastContent, /bob@x\.com/);
        assert.match(story.lastContent, /carol@x\.com/);
    } finally { await story.cleanup(); }
});

test("story: report the number of files in a directory", async (t) => {
    // src/ has 2 files: app.js, config.json.
    const story = await runStory({
        signal: t.signal,
        label: "count-files",
        prompt: "How many files are in the src/ directory?",
    });
    try {
        if (story.finalStatus !== 200 || !/\b2\b/.test(story.lastContent)) await story.dump();
        assert.equal(story.finalStatus, 200);
        assert.match(story.lastContent, /\b2\b/,
            `final reply contains the count (2); got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("story: draft a brief, tighten it, then file it away", async (t) => {
    // Authoring → refinement → reorganization in ONE workspace. The model creates prose (brief.md),
    // then must re-READ its OWN prior work and EDIT it shorter (the refine turn renders its
    // bounded landed receipt — {§edit-result-receipt-projection}), then MOVE it out of the root.
    // Outcome asserts on disk, snapshotting size BEFORE the move. All natural prompts.
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
            // Snapshot brief.md's size after the draft (0) and the tighten (1), BEFORE the move (2) relocates it.
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
    } finally { await chain.cleanup(); }
});

test("story: remember a fact, then recall it later", async (t) => {
    // Recall across prompts in one workspace; the model chooses how to retain the fact.
    const chain = await runStoryChain({
        signal: t.signal,
        label: "memory",
        maxTurns: 6,
        prompts: [
            "Hang onto this for me: the staging release marker is BLUE-7788-QRT.",
            "Remind me — what was that staging release marker?",
        ],
    });
    try {
        assert.equal(chain.steps[1].finalStatus, 200, "the recall turn concluded");
        assert.match(chain.steps[1].lastContent, /BLUE-7788-QRT/,
            `recalled the earlier marker; got: ${chain.steps[1].lastContent.slice(0, 200)}`);
    } finally { await chain.cleanup(); }
});

test("story: compute a value too big for arithmetic shortcuts", async (t) => {
    // 25! = 15511210043330985984000000 overflows 64-bit, so shell arithmetic can't do it — the
    // model reaches for a real runtime (Node.js BigInt / Python 3). Natural prompt; the exact value proves it.
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
        assert.match(story.lastContent, wanted,
            `computed 25! exactly; got: ${story.lastContent.slice(0, 200)}`);
    } finally { await story.cleanup(); }
});

test("an execution-restricted workspace answers a shell-tempting question without a denial cycle", async (t) => {
    // Deterministic coverage pins policy projection and dispatch; this story
    // probes whether a model naturally uses the remaining admitted surface.
    const story = await runStory({
        signal: t.signal,
        label: "capability-steer",
        prompt: "How many files are in this project, roughly? A ballpark from what you can see is fine.",
        maxTurns: 6,
        capabilities: { deny: [{ scheme: "exec" }] },
    });
    try {
        if (story.finalStatus !== 200) await story.dump();
        assert.equal(story.finalStatus, 200, "the attenuated loop concluded (no 403-cycle 508, no max_turns)");
        assert.ok(story.lastContent.length > 0, "a direct prose answer landed");
    } finally { await story.cleanup(); }
});

// {§test-artifact-retention} — create, revise, and reread one model-authored file across loops.
test("{§test-artifact-retention}: create and revise a decisions document without fragmenting identity", async (t) => {
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
        // {§db-migrations}: one file remains one row across all three loops.
        const row = await chain.db.test_count_rows_for_pathname.get<{ n: number }>({ pathname: "docs/decisions.md" });
        assert.equal(row?.n, 1, "the created file has exactly one durable identity");
    } finally { await chain.cleanup(); }
});
