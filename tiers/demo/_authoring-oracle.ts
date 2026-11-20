import assert from "node:assert/strict";

export const assertSingleProseParagraph = (markdown: string): void => {
    const prose = markdown.trim().replace(/^#{1,6}[\t ]+[^\r\n]+(?:\r\n|\n|\r)+/, "").trim();
    assert.ok(prose.length > 0, "the refined brief retains prose after an optional heading");
    assert.doesNotMatch(prose, /(?:\r\n|\n|\r)[\t ]*(?:\r\n|\n|\r)/, "the refined brief has one prose paragraph");
};
