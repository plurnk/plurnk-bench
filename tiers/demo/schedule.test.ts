import assert from "node:assert/strict";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";

test("demo: the model schedules and receives a one-time reminder", async (t) => {
    const workspace = await liveWorkspace({ name: "demo-schedule" });
    try {
        const loop = await liveLoop(workspace, 2, {
            prompt: "Use the scheduled-message tooling to arrange exactly one reminder to yourself within the next few seconds, "
                + "containing the text schedule-probe-ack. After the reminder actually arrives, quote its text in your response. "
                + "Do not replace the schedule with an immediate message or a shell timer.",
            maxTurns: 12,
        }, { signal: t.signal });
        assert.equal(loop.finalStatus, 200, "the reminder task concluded successfully");
        const messages = await workspace.db.test_messages_by_session.all<{ source: string | null; body: string }>({ session_id: loop.modelSessionId });
        const reminders = messages.filter(({ source }) => source?.startsWith("schedule://") === true);
        assert.equal(reminders.length, 1, "the scheduling module delivered exactly one reminder");
        assert.match(reminders[0].body, /schedule-probe-ack/u);
        assert.match(loop.lastContent, /schedule-probe-ack/u, "the model acknowledged the received reminder");
    } finally {
        await workspace.cleanup();
    }
});
