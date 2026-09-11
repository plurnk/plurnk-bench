// {§pair-mini-digest} — the converter over a trimmed real trajectory (koota-entity, 2026-09-08).
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import MiniTrajectoryReader from "./mini-trajectory.ts";

const FIXTURE = resolve(import.meta.dirname, "fixtures/mini-trajectory.sample.json");

test("[§pair-mini-digest] a trajectory reads into per-step actions, observations, and usage", () => {
    const t = MiniTrajectoryReader.read(FIXTURE);
    assert.equal(t.steps.length, 3, "three responses in the fixture");
    assert.match(t.task ?? "", /^Please solve this issue: Add an entity snapshot/);
    const first = t.steps[0]!;
    assert.equal(first.index, 1);
    assert.equal(first.text, "I'll start by exploring the repository structure.");
    assert.equal(first.command, "pwd && ls -la && cat package.json 2>/dev/null");
    assert.equal(first.returncode, 0);
    assert.ok((first.outputLines ?? 0) > 0 && (first.outputHead ?? "").startsWith("/app"), "the observation answering the call is attached by call id");
    assert.deepEqual(first.usage, { input: 1383, cached: 0, output: 51 });
    assert.equal(t.totals.responses, 3);
    assert.equal(t.totals.input, t.steps.reduce((n, s) => n + (s.usage?.input ?? 0), 0));
    assert.equal(t.exit.status, "Submitted");
});

test("[§pair-mini-digest] the rendering is one section per step in the digest register", () => {
    const md = MiniTrajectoryReader.render(MiniTrajectoryReader.read(FIXTURE));
    assert.match(md, /^# mini-swe-agent steps\n/);
    assert.match(md, /Responses: 3  Exit: Submitted/);
    assert.match(md, /## step 1\n\nI'll start by exploring the repository structure\.\n\n```bash\npwd && ls -la && cat package\.json 2>\/dev\/null\n```\n\nexit 0, \d+ lines/);
    assert.match(md, /tokens: input=1383 cached=0 output=51/);
    assert.equal((md.match(/^## step /gm) ?? []).length, 3);
});

test("[§pair-mini-digest] absent fields stay absent: a response without a call has no observation and no usage is null, never zero", () => {
    const t = MiniTrajectoryReader.fromMessages([
        { role: "system", content: "s" },
        { role: "user", content: "task" },
        { object: "response", output: [{ type: "message", content: [{ type: "output_text", text: "thinking aloud" }] }] },
        { role: "exit", extra: { exit_status: "Submitted", submission: "" } },
    ] as never, "m");
    assert.deepEqual(t.steps[0], { index: 1, text: "thinking aloud", reasoning: null, command: null, returncode: null, outputLines: null, outputHead: null, usage: null });
    assert.deepEqual(t.totals, { responses: 1, input: 0, cached: 0, output: 0, reasoningResponses: 0 });
});
