// {§tier-corpus} (#893): every plurnk.edit addressing form the schema teaches, witnessed live across
// two grouped workspace boots (one isolated model session and target file per form).
import assert from "node:assert/strict";
import { DigestRender, EDIT_FORMS, type EditForm } from "@plurnk/plurnk-digest";
import {
    liveLoop,
    liveTest as test,
    liveWorkspace,
    namedModelSession,
    readBody,
    seedEntry,
    type LiveWorkspace,
} from "@plurnk/plurnk-service/harness";

const SEED = "alpha\nbeta\ngamma\ndelta\n";
const normalizeTrailingNewline = (value: string | undefined): string | undefined => value?.replace(/\n$/u, "");

type EditRow = { id: number; pathname: string | null; status_rx: number; line_marker: string | null; pattern: string | null };
const editForms = async (s: LiveWorkspace, sessionId: number): Promise<{ form: EditForm; status: number }[]> => {
    const rows = await s.db.test_edit_rows_by_session.all<EditRow>({ session_id: sessionId });
    return rows.map((row) => ({ form: DigestRender.editForm(row), status: row.status_rx }));
};

const TAUGHT: readonly EditForm[] = EDIT_FORMS.filter((form) => form !== "offset");

interface EditSpecimen {
    readonly form: EditForm;
    readonly prompt: (file: string) => string;
    readonly expected: string;
    readonly seed?: string;
}

const COORDINATE_FORMS: readonly EditSpecimen[] = [
    {
        form: "line",
        prompt: (file) => `Replace line 2 of workspace:///${file} with \`beta prime\`.`,
        expected: "alpha\nbeta prime\ngamma\ndelta",
    },
    {
        form: "hash",
        prompt: (file) => `In workspace:///${file}, replace the line that says \`gamma\` with \`gamma prime\`.`,
        expected: "alpha\nbeta\ngamma prime\ndelta",
    },
    {
        form: "range",
        prompt: (file) => `Replace lines 2 through 3 of workspace:///${file} with the single line \`middle\`.`,
        expected: "alpha\nmiddle\ndelta",
    },
    {
        form: "insert",
        prompt: (file) => `Insert a new line \`beta-and-a-half\` immediately before line 3 of workspace:///${file}; every existing line stays.`,
        expected: "alpha\nbeta\nbeta-and-a-half\ngamma\ndelta",
    },
    {
        form: "column",
        prompt: (file) => `In workspace:///${file}, on line 1 replace only the characters from column 1 up to but not including column 3 with \`AL\`.`,
        expected: "ALpha\nbeta\ngamma\ndelta",
    },
];

const BOUNDARY_AND_PATTERN_FORMS: readonly EditSpecimen[] = [
    {
        form: "prepend",
        prompt: (file) => `Add the line \`title\` at the very top of workspace:///${file}, before its first line.`,
        expected: "title\nalpha\nbeta\ngamma\ndelta",
    },
    {
        form: "append",
        prompt: (file) => `Add the line \`omega\` at the very end of workspace:///${file}, after its last line.`,
        expected: "alpha\nbeta\ngamma\ndelta\nomega",
    },
    {
        form: "pattern",
        seed: "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\nrho\nsigma\ntau\nupsilon\n",
        prompt: (file) => `In workspace:///${file}, replace every \`a\` that ends a line with \`A\`.`,
        expected: "alphA\nbetA\ngammA\ndeltA\nepsilon\nzetA\netA\nthetA\niotA\nkappA\nlambdA\nmu\nnu\nxi\nomicron\npi\nrho\nsigmA\ntau\nupsilon",
    },
    {
        form: "whole",
        prompt: (file) => `Overwrite workspace:///${file} so that its entire content is exactly the one line \`fresh\`.`,
        expected: "fresh",
    },
];

const runEditGroup = async (
    label: string,
    group: readonly EditSpecimen[],
    signal: AbortSignal,
    diagnostic: (message: string) => void,
): Promise<void> => {
    const s = await liveWorkspace({ name: `live-edit-${label}-${crypto.randomUUID()}` });
    try {
        let rpcId = 2;
        for (const kind of group) {
            const file = `notes-${kind.form}.md`;
            await seedEntry(s.db, s.workspaceId, { pathname: file, content: kind.seed ?? SEED });
            const sessionId = await namedModelSession(s.daemon, s.workspaceId, `edit-${kind.form}`);
            const loop = await liveLoop(
                s,
                rpcId++,
                { prompt: kind.prompt(file), sessionId, maxTurns: 6 },
                { signal },
            );
            assert.equal(loop.finalStatus, 200, `[${kind.form}] loop finished cleanly`);
            assert.equal(
                normalizeTrailingNewline(await readBody(s.db, file)),
                normalizeTrailingNewline(kind.expected),
                `[${kind.form}] the edit landed exactly`,
            );
            const edits = await editForms(s, sessionId);
            const landed = edits.filter(({ status }) => status < 300);
            assert.equal(landed.length, 1, `[${kind.form}] one landed EDIT: ${JSON.stringify(edits)}`);
            assert.ok(TAUGHT.includes(landed[0].form), `[${kind.form}] authored in a taught form: ${JSON.stringify(edits)}`);
            assert.equal(edits.filter(({ status }) => status >= 400).length, 0, `[${kind.form}] no refused attempt on the way: ${JSON.stringify(edits)}`);
            diagnostic(`${kind.form}: authored as ${landed[0].form}`);
        }
    } finally {
        await s.cleanup();
    }
};

test("live: EDIT coordinate and structural forms — line, hash, range, insert, and column land without refusals", async (t) => {
    await runEditGroup("coordinate", COORDINATE_FORMS, t.signal, (msg) => t.diagnostic(msg));
});

test("live: EDIT boundary, pattern, and whole forms — prepend, append, pattern, and whole land without refusals", async (t) => {
    await runEditGroup("boundary-pattern", BOUNDARY_AND_PATTERN_FORMS, t.signal, (msg) => t.diagnostic(msg));
});
