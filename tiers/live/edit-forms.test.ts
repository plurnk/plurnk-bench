// {§digest-forensic-fidelity} (#893): every EDIT addressing form the card teaches, witnessed live. Each
// specimen is one sentence whose natural EDIT is one form. The landing is asserted on the entry's
// content: exactly one EDIT, no refusal on the way, authored in a taught form. Which taught form
// the model chose is reported, not required — models take any taught address that lands, and the
// census on the ladder measures the distribution; the specimen measures the landing.
import assert from "node:assert/strict";
import { DigestRender, EDIT_FORMS, type EditForm } from "@plurnk/plurnk-digest";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { liveLoop, liveWorkspace, readBody, seedEntry, type LiveWorkspace } from "@plurnk/plurnk-service/harness";

const SEED = "alpha\nbeta\ngamma\ndelta";

type EditRow = { id: number; pathname: string | null; status_rx: number; line_marker: string | null; pattern: string | null };
const editForms = async (s: LiveWorkspace, sessionId: number): Promise<{ form: EditForm; status: number }[]> => {
    const rows = await s.db.test_edit_rows_by_session.all<EditRow>({ session_id: sessionId });
    return rows.map((row) => ({ form: DigestRender.editForm(row), status: row.status_rx }));
};

// The card teaches every form but the three-mark offset scope.
const TAUGHT: readonly EditForm[] = EDIT_FORMS.filter((form) => form !== "offset");

const FORMS: readonly {
    form: EditForm;
    prompt: string;
    expected: string;
    // A seed long enough that rewriting it is the unnatural choice.
    seed?: string;
}[] = [
    { form: "line", prompt: "Replace line 2 of workspace:///notes.md with `beta prime`.", expected: "alpha\nbeta prime\ngamma\ndelta" },
    { form: "hash", prompt: "In workspace:///notes.md, replace the line that says `gamma` with `gamma prime`.", expected: "alpha\nbeta\ngamma prime\ndelta" },
    { form: "range", prompt: "Replace lines 2 through 3 of workspace:///notes.md with the single line `middle`.", expected: "alpha\nmiddle\ndelta" },
    { form: "insert", prompt: "Insert a new line `beta-and-a-half` immediately before line 3 of workspace:///notes.md; every existing line stays.", expected: "alpha\nbeta\nbeta-and-a-half\ngamma\ndelta" },
    { form: "column", prompt: "In workspace:///notes.md, on line 1 replace only the characters from column 1 up to but not including column 3 with `AL`.", expected: "ALpha\nbeta\ngamma\ndelta" },
    { form: "prepend", prompt: "Add the line `title` at the very top of workspace:///notes.md, before its first line.", expected: "title\nalpha\nbeta\ngamma\ndelta" },
    { form: "append", prompt: "Add the line `omega` at the very end of workspace:///notes.md, after its last line.", expected: "alpha\nbeta\ngamma\ndelta\nomega" },
    { form: "pattern", seed: "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\nrho\nsigma\ntau\nupsilon", prompt: "In workspace:///notes.md, replace every `a` that ends a line with `A`.", expected: "alphA\nbetA\ngammA\ndeltA\nepsilon\nzetA\netA\nthetA\niotA\nkappA\nlambdA\nmu\nnu\nxi\nomicron\npi\nrho\nsigmA\ntau\nupsilon" },
    { form: "whole", prompt: "Overwrite workspace:///notes.md so that its entire content is exactly the one line `fresh`.", expected: "fresh" },
];

for (const kind of FORMS) test(`live: EDIT by ${kind.form} — one taught EDIT lands the sentence that means it`, async (t) => {
    const s = await liveWorkspace({ name: `live-edit-${kind.form}-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "notes.md", content: kind.seed ?? SEED });
        const loop = await liveLoop(s, 2, { prompt: kind.prompt, maxTurns: 6 }, { signal: t.signal });
        assert.equal(loop.finalStatus, 200);
        assert.equal(await readBody(s.db, "notes.md"), kind.expected, "the edit landed exactly");
        const edits = await editForms(s, loop.modelSessionId);
        // A 304 changed nothing ({§edit}): neither a landing nor a refusal.
        const landed = edits.filter(({ status }) => status < 300);
        assert.equal(landed.length, 1, `one landed EDIT: ${JSON.stringify(edits)}`);
        assert.ok(TAUGHT.includes(landed[0].form), `authored in a taught form: ${JSON.stringify(edits)}`);
        assert.equal(edits.filter(({ status }) => status >= 400).length, 0, `no refused attempt on the way: ${JSON.stringify(edits)}`);
        t.diagnostic(`${kind.form}: authored as ${landed[0].form}`);
    } finally { await s.cleanup(); }
});
