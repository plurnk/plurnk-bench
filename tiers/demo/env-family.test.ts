// {§tier-corpus} — durable session environment registry across separate commands.
import assert from "node:assert/strict";
import { liveLoop, liveTest as test, liveWorkspace } from "@plurnk/plurnk-service/harness";

test("demo: a value the model sets persists into a later command", async (t) => {
    const s = await liveWorkspace({ name: `env-persist-${crypto.randomUUID()}` });
    try {
        const loop = await liveLoop(
            s,
            2,
            {
                prompt: "Configure your environment so that CARGO_TARGET_DIR is /tmp/plurnk-demo-shared "
                    + "for every command you run from now on — not just one. Afterwards, in a separate "
                    + "later step, run a command that prints CARGO_TARGET_DIR and report exactly what it printed.",
                maxTurns: 16,
            },
            { signal: t.signal },
        );
        assert.equal(loop.finalStatus, 200, "loop terminated cleanly");
        assert.match(
            loop.lastContent,
            /\/tmp\/plurnk-demo-shared/u,
            "the later command saw the value, so it came from the session's registry and not an inline prefix",
        );
        assert.ok(loop.turnIds.length >= 2, "setting and observing are separate turns; one turn cannot distinguish the two");
    } finally {
        await s.cleanup();
    }
});
