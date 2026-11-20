// {§tier-corpus} (#899): native multimodal observation retention, single-arrival captioning, and log curation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildPdf,
    liveLoop,
    liveTest as test,
    liveWorkspace,
    StoredPacket,
    wav,
    type LiveWorkspace,
} from "@plurnk/plurnk-service/harness";

// 128×64 RGB PNG: green left panel, purple right panel; no textual metadata.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAIAAAABACAIAAABdtOgoAAAA3ElEQVR4nO3RwQnAABDDsBu9o7c79CECJplAvntu+t+m7wULsH0uWACPWIDhe8ECbJ8LFsAjFmD4XrAA2+eCBfCIBRi+FyzA9rlgATxiAYbvBQuwfS5YAI9YgOF7wQJsnwsWwCMWYPhesADb54IF8IgFGL4XLMD2uWABPGIBhu8FC7B9LlgAj1iA4XvBAmyfCxbAIxZg+F6wANvnggXwiAUYvhcswPa5YAE8YgGG7wULsH0uWACPWIDhe8ECbJ8LFsAjFmD4XrAA2+eCBfCIBRi+FyzA9rlgATzin7/kLQFpLxPquAAAAABJRU5ErkJggg==", "base64");
const contentHash = createHash("sha256").update(PNG).digest("hex");

const packets = async (s: LiveWorkspace, turnIds: readonly number[]) => {
    const rows = await Promise.all(turnIds.map((id) => s.db.test_get_packet.get<{ packet: string | null }>({ id })));
    return rows.flatMap((row) => {
        const packet = StoredPacket.parse(row?.packet ?? null);
        return packet === null ? [] : [packet];
    });
};

const accountOf = (noun: string) =>
    `Reply with exactly one line and nothing else, in this form: \`distinct_${noun}s=<n> new_${noun}_this_message=<yes|no>\` — n is how many distinct ${noun}s you have seen so far, and the second field says whether a new ${noun} arrived with this message.`;

test("live: a client-attached image is captioned as one earlier READ on follow-up and retires cleanly on log curation", { requires: ["input:image"] }, async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-native-live-"));
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(async () => { await rm(projectRoot, { recursive: true, force: true }); });
    try {
        await writeFile(join(projectRoot, "sample.png"), PNG);
        const s = await liveWorkspace({ name: `live-native-observation-${crypto.randomUUID()}`, projectRoot });
        lifetime.defer(s.cleanup);
        const member = await s.invokeWorkspaceAction("workspace.members.add", { files: ["sample.png"] }) as { status: number };
        assert.equal(member.status, 201);
        await s.daemon.settleFunctionality(s.workspaceId);

        const first = await liveLoop(s, 2, {
            prompt: "What are the two main colors in sample.png, and which is on the left?",
            openPaths: ["sample.png"],
            maxTurns: 6,
        }, { signal: t.signal });
        assert.equal(first.finalStatus, 200);
        assert.match(first.lastContent, /green/i);
        assert.match(first.lastContent, /purple|magenta/i);
        const observed = (await packets(s, first.turnIds)).flatMap((packet) => packet.attachments ?? [])
            .find((attachment) => attachment.contentHash === contentHash);
        assert.ok(observed, "the live provider received the source image as a native part");

        const second = await liveLoop(s, 3, { prompt: accountOf("image"), maxTurns: 4 }, { signal: t.signal });
        assert.equal(second.modelSessionId, first.modelSessionId);
        assert.equal(second.finalStatus, 200);
        const retained = (await packets(s, second.turnIds))[0]?.attachments ?? [];
        assert.ok(
            retained.some((attachment) => attachment.contentHash === contentHash && attachment.coordinate === observed.coordinate),
            "the image survives completion and the next prompt without a new READ",
        );
        assert.match(second.lastContent, /distinct_images=1\b/u, `the image is counted once: ${second.lastContent}`);
        assert.match(second.lastContent, /new_image_this_message=no\b/u, `nothing new arrived with the message: ${second.lastContent}`);

        const cleanup = await liveLoop(s, 4, {
            prompt: "Remove the sample.png observation from your working log; keep the original image file untouched.",
            maxTurns: 6,
        }, { signal: t.signal });
        assert.equal(cleanup.finalStatus, 200);
        const active = await s.db.engine_render_log.all<{ op: string; rx: string }>({ session_id: first.modelSessionId });
        assert.equal(
            active.some((row) => row.op === "read" && JSON.parse(row.rx).nativeContentHash === contentHash),
            false,
            "curation removes the native observation from the active log",
        );
        assert.deepEqual(await readFile(join(projectRoot, "sample.png")), PNG, "log curation leaves the file unchanged");
        const history = await s.db.test_log_entries_by_session_op_full.all<{ rx: string }>({ session_id: first.modelSessionId, op: "read" });
        assert.ok(history.some((row) => JSON.parse(row.rx).nativeContentHash === contentHash), "immutable READ evidence survives curation");
    } finally {
        await lifetime.disposeAsync();
    }
});

for (const kind of [
    { modality: "pdf" as const, noun: "document", file: "contract.pdf", bytes: Buffer.from(buildPdf({ title: "Contract" })), question: "How many pages does contract.pdf have?", answer: /\b(1|one)\b/iu },
    { modality: "audio" as const, noun: "audio_clip", file: "clip.wav", bytes: wav(), question: "How long is clip.wav, in seconds?", answer: /\b(1|one)\b/iu },
]) test(`live: a retained ${kind.modality} is reported as one earlier READ, never as a new arrival`, { requires: [`input:${kind.modality}`] }, async (t) => {
    const projectRoot = await mkdtemp(join(tmpdir(), `plurnk-native-${kind.modality}-`));
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(async () => { await rm(projectRoot, { recursive: true, force: true }); });
    try {
        await writeFile(join(projectRoot, kind.file), kind.bytes);
        const s = await liveWorkspace({ name: `live-native-${kind.modality}-${crypto.randomUUID()}`, projectRoot });
        lifetime.defer(s.cleanup);
        const member = await s.invokeWorkspaceAction("workspace.members.add", { files: [kind.file] }) as { status: number };
        assert.equal(member.status, 201);
        await s.daemon.settleFunctionality(s.workspaceId);
        const hash = createHash("sha256").update(kind.bytes).digest("hex");

        const first = await liveLoop(s, 2, { prompt: kind.question, openPaths: [kind.file], maxTurns: 6 }, { signal: t.signal });
        assert.equal(first.finalStatus, 200);
        assert.match(first.lastContent, kind.answer);
        const observed = (await packets(s, first.turnIds)).flatMap((packet) => packet.attachments ?? []).find((attachment) => attachment.contentHash === hash);
        assert.ok(observed, `the route received the ${kind.modality} as a native part`);

        const second = await liveLoop(s, 3, { prompt: accountOf(kind.noun), maxTurns: 4 }, { signal: t.signal });
        assert.equal(second.finalStatus, 200);
        const retained = (await packets(s, second.turnIds))[0]?.attachments ?? [];
        assert.ok(retained.some((attachment) => attachment.coordinate === observed.coordinate), "the observation is still in the packet when the account is asked for");
        assert.match(second.lastContent, new RegExp(`distinct_${kind.noun}s=1\\b`, "u"), `counted once: ${second.lastContent}`);
        assert.match(second.lastContent, new RegExp(`new_${kind.noun}_this_message=no\\b`, "u"), `nothing new arrived: ${second.lastContent}`);
    } finally {
        await lifetime.disposeAsync();
    }
});
