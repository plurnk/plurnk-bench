// {§plurnk-skill} — "integrate plurnk with X" requests, each pointing a different way (#972). The
// plurnk skill's extensibility chapter is reachable only on demand; these stories record whether a
// model finds it, which way it settles the request, and which surface it builds.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveLoop, liveWorkspace } from "@plurnk/plurnk-service/harness";
import { ResourceState } from "@plurnk/plurnk-service/harness";
import { initializeDemoRepository } from "@plurnk/plurnk-service/harness";

const CHAPTER = "skill://plurnk/references/extensibility.md";

const integrate = async (t: TestContext, label: string, prompt: string): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), `plurnk-demo-${label}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    initializeDemoRepository(root, "empty project");
    const s = await liveWorkspace({ name: `demo-${label}-${crypto.randomUUID()}`, projectRoot: root });
    try {
        const result = await liveLoop(s, 2, { prompt, maxTurns: 48 }, { signal: t.signal });
        assert.equal(result.finalStatus, 200, `[${label}] the request concludes`);
        assert.ok(result.lastContent.trim().length > 0, `[${label}] an answer arrives`);
        assert.deepEqual(await ResourceState.check(s.db), [], `[${label}] the workspace stays lawful`);
        const log = await s.daemon.readLog({ workspaceId: s.workspaceId, sessionId: result.modelSessionId, limit: Number.MAX_SAFE_INTEGER });
        const read = log.some((row) => row.op === "READ" && JSON.stringify(row).includes(CHAPTER));
        t.diagnostic(`[${label}] read ${CHAPTER}: ${read}`);
    } finally { await s.cleanup(); }
};

test("demo: integrate plurnk with an issue tracker's API", { timeout: 1_800_000 }, async (t) => {
    await integrate(t, "extend-tracker", "Create an extension that integrates plurnk with Linear, so that you can read and update my Linear issues. Put whatever it needs in this project.");
});

test("demo: integrate plurnk into a chat bot", { timeout: 1_800_000 }, async (t) => {
    await integrate(t, "extend-chat", "Create an extension that integrates plurnk into a Discord bot, so people in a Discord channel can talk to plurnk. Put whatever it needs in this project.");
});

test("demo: integrate plurnk with webhooks served by its own daemon", { timeout: 1_800_000 }, async (t) => {
    await integrate(t, "extend-webhook", "Create an extension that integrates plurnk with GitHub webhooks: GitHub should POST to an endpoint that plurnk's own daemon serves, and each new issue should start a new plurnk session. Put whatever it needs in this project.");
});
