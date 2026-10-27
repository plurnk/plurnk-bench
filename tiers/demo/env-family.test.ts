// {§tier-corpus} {§tier-corpus} — the env family as a model actually meets it.
//
// These two stories exist because correctness tests cannot answer the question the feature is
// for: can a model find the environment surface and use it without being told the verbs? They
// were written against the agreed interface BEFORE the adapter, so the adapter has a target
// rather than a retrofit.
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";
import { namedModelSession } from "@plurnk/plurnk-service/harness";

// Story one: a value already in the session's environment, asked for plainly.
test("demo: the model reads a variable already in its session's environment", async (t) => {
    const s = await liveWorkspace({ name: `env-read-${crypto.randomUUID()}` });
    try {
        const sessionId = await namedModelSession(s.daemon, s.workspaceId, "main");
        await s.daemon.invokeModuleAction("session.env.add", { alias: "FOO_VERSION", definition: { value: "42" } },
            { scope: "session", workspaceId: s.workspaceId, sessionId });
        const loop = await liveLoop(s, 2, { prompt: "What's the FOO_VERSION environment variable?", sessionId, maxTurns: 6 }, { signal: t.signal });
        assert.equal(loop.finalStatus, 200, "loop terminated cleanly");
        assert.match(loop.lastContent, /\b42\b/u, "the reply gives the value the session's environment holds");
    } finally { await s.cleanup(); }
});

// Story two: a registry rather than a prefix.
//
// The discriminating assertion is the SECOND command. A model that sets the variable inline
// (`CARGO_TARGET_DIR=… cmd`) satisfies the first half and fails here, which is precisely the
// difference between an ephemeral prefix and durable session state.
test("demo: a value the model sets persists into a later command", async (t) => {
    const s = await liveWorkspace({ name: `env-persist-${crypto.randomUUID()}` });
    try {
        const loop = await liveLoop(
            s, 2,
            {
                prompt: "Configure your environment so that CARGO_TARGET_DIR is /tmp/plurnk-demo-shared "
                    + "for every command you run from now on — not just one. Afterwards, in a separate "
                    + "later step, run a command that prints CARGO_TARGET_DIR and report exactly what it printed.",
                maxTurns: 16,
            },
            { signal: t.signal },
        );
        assert.equal(loop.finalStatus, 200, "loop terminated cleanly");
        assert.match(loop.lastContent, /\/tmp\/plurnk-demo-shared/u,
            "the later command saw the value, so it came from the session's registry and not an inline prefix");
        assert.ok(loop.turnIds.length >= 2, "setting and observing are separate turns; one turn cannot distinguish the two");
    } finally { await s.cleanup(); }
});
