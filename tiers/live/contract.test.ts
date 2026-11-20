// Live coverage of multi-entry content selection and ranged COPY ({§tier-corpus}).
// Single-op READ and EDIT live in `plurnk-core/test/live/smoke.test.ts` and `edit-forms.test.ts`.
import assert from "node:assert/strict";
import { liveLoop, liveTest as test, liveWorkspace, readBody, seedEntry } from "@plurnk/plurnk-service/harness";

test("live: content-match selection — the model culls entries by CONTENT (fruit), verified forensically", async (t) => {
    const s = await liveWorkspace({ name: `live-contract-content-select-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "pantry/alpha.md", content: "a crisp autumn apple, freshly picked" });
        await seedEntry(s.db, s.workspaceId, { pathname: "pantry/bravo.md", content: "a sour yellow lemon" });
        await seedEntry(s.db, s.workspaceId, { pathname: "pantry/charlie.md", content: "buy milk and bread" });
        await liveLoop(s, 3, { prompt: "Tidy the pantry: delete every entry in workspace:///pantry/ whose content does not name a fruit." }, { signal: t.signal });
        assert.equal(await readBody(s.db, "pantry/charlie.md"), undefined, "milk & bread is no fruit — read, classified, deleted");
        assert.match(await readBody(s.db, "pantry/alpha.md") ?? "", /apple/, "the apple entry is a fruit — kept");
        assert.match(await readBody(s.db, "pantry/bravo.md") ?? "", /lemon/, "the lemon entry is a fruit — kept");
    } finally {
        await s.cleanup();
    }
});

test("live: copy a line range into a new entry", async (t) => {
    const s = await liveWorkspace({ name: `live-contract-copy-L-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "src.md", content: "one\ntwo\nthree\nfour" });
        await liveLoop(s, 2, { prompt: "Copy the second and third lines of workspace:///src.md into a new entry workspace:///slice.md." }, { signal: t.signal });
        assert.match(await readBody(s.db, "slice.md") ?? "", /^two\nthree\n?$/, "the result contains only source lines 2-3");
    } finally {
        await s.cleanup();
    }
});
