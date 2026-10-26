// Live xpath/jsonpath coverage. Each test SEEDS its entry (the model never writes the JSON/HTML),
// then asks a NATURAL question whose answer requires extracting from that entry — and asserts the
// OUTCOME (the value), never the path. The model drives the matcher (jsonpath/xpath) and any pick
// itself; we do NOT script ops or hardcode log coordinates. Coordinates shift with initialization
// and no real task names them; scripting them made these brittle. The matcher mechanics are pinned deterministically
// in intg; this tier proves gemma actually answers real extraction questions through the prod loop
// (loop.run via the daemon — liveWorkspace + liveLoop). Seeded pathnames are slash-prefixed (the
// RFC-3986 path the parser resolves workspace:///x.json to), so seed and the model's READ can't drift.

import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { liveWorkspace, liveLoop, seedEntry } from "@plurnk/plurnk-service/harness";


test("live: model answers a JSON field question (jsonpath extraction)", async (t) => {
    const s = await liveWorkspace({ name: `live-xpjp-jsonpath-field-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "/config.json", content: '{"host":"db.internal","pool":5}', mimetype: "application/json" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "What is the value of the `host` field in workspace:///config.json?" }, { signal: t.signal });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /db\.internal/);
    } finally { await s.cleanup(); }
});

test("live: model lists every value from a JSON array (jsonpath wildcard)", async (t) => {
    const s = await liveWorkspace({ name: `live-xpjp-jsonpath-wildcard-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "/team.json", content: '{"users":[{"name":"Alice"},{"name":"Bob"}]}', mimetype: "application/json" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "List the names of every user in workspace:///team.json." }, { signal: t.signal });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Alice/);
        assert.match(lastContent, /Bob/);
    } finally { await s.cleanup(); }
});

test("live: model answers an HTML heading question (xpath extraction)", async (t) => {
    const s = await liveWorkspace({ name: `live-xpjp-xpath-h1-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "/page.html", content: "<html><body><h1>Welcome</h1></body></html>", mimetype: "text/html" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "What does the h1 heading in workspace:///page.html say?" }, { signal: t.signal });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Welcome/);
    } finally { await s.cleanup(); }
});

test("live: model picks the first item out of a JSON array (extract then pick first)", async (t) => {
    // The answer requires extracting the user names and
    // taking the first — however the model chooses to get there. No scripted ops, no log coordinates.
    const s = await liveWorkspace({ name: `live-xpjp-compose-first-${crypto.randomUUID()}` });
    try {
        await seedEntry(s.db, s.workspaceId, { pathname: "/team.json", content: '{"users":[{"name":"Alice"},{"name":"Bob"}]}', mimetype: "application/json" });
        const { finalStatus, lastContent } = await liveLoop(s, 2, { prompt: "Who is the first user listed in workspace:///team.json?" }, { signal: t.signal });
        assert.equal(finalStatus, 200);
        assert.match(lastContent, /Alice/);
    } finally { await s.cleanup(); }
});
