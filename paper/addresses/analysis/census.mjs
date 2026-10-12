// Curation census over a Plurnk campaign's run databases.
// usage: node census.mjs <release-dir> <out-dir>
// Each attempt's provenance.json in the release names its run directory (`runDir`), which holds
// the daemon's plurnk.db. Writes census.tsv (one row per attempt) and census.json (aggregates).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [release, out] = process.argv.slice(2);
if (!release || !out) { console.error("usage: node census.mjs <release-dir> <out-dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });

const attempts = [];
const trials = join(release, "plurnk", "trials");
for (const instance of readdirSync(trials).sort()) {
    for (const name of readdirSync(join(trials, instance)).filter((n) => n.startsWith("attempt-")).sort()) {
        const dir = join(trials, instance, name);
        const { runDir } = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
        const verdict = existsSync(join(dir, "verdict.txt")) ? readFileSync(join(dir, "verdict.txt"), "utf8").trim() : "";
        attempts.push({ instance, attempt: Number(name.slice("attempt-".length)), run: runDir, verdict });
    }
}

const OPS = ["NOTE", "FIND", "READ", "EDIT", "COPY", "MOVE", "KILL", "WORK", "FORK", "WAIT", "SEND", "sh"];
const DIALECTS = ["none", "regex", "fts", "glob", "graph", "jsonpath", "xpath"];
const GAUGE = /"name":"budget".*?"content":"\{\\"tokens\\":(\d+)(?:,\\"budget\\":(\d+))?/u;

function census(a) {
    const db = new DatabaseSync(join(a.run, "plurnk.db"), { readOnly: true });
    try {
        const row = { instance: a.instance, attempt: a.attempt, verdict: a.verdict, run: a.run };
        row.turns = db.prepare("SELECT COUNT(*) AS n FROM turns").get().n;
        row.packets = db.prepare("SELECT COUNT(*) AS n FROM turn_packets WHERE packet IS NOT NULL").get().n;
        const ops = db.prepare("SELECT op, status_rx AS status, COUNT(*) AS n FROM log_entries WHERE origin='model' GROUP BY op, status_rx").all();
        row.modelOps = ops.reduce((s, r) => s + r.n, 0);
        row.refused = ops.filter((r) => r.status >= 400).reduce((s, r) => s + r.n, 0);
        for (const op of OPS) row[op] = ops.filter((r) => r.op === op).reduce((s, r) => s + r.n, 0);
        row.otherOps = row.modelOps - OPS.reduce((s, op) => s + row[op], 0);
        // Turns in which the model's only operation was a NOTE: a decision recorded without an act.
        row.modelTurns = db.prepare("SELECT COUNT(DISTINCT turn_id) AS n FROM log_entries WHERE origin='model'").get().n;
        row.noteOnlyTurns = db.prepare("SELECT COUNT(*) AS n FROM (SELECT turn_id FROM log_entries WHERE origin='model' GROUP BY turn_id HAVING SUM(op != 'NOTE') = 0)").get().n;

        // READ selection: a line range, a pattern, or the whole resource; and what was read.
        const reads = db.prepare(`SELECT
            CASE WHEN lineMarker IS NOT NULL AND lineMarker != '' THEN 'ranged' WHEN json_extract(tx,'$.matcher') IS NOT NULL THEN 'pattern' ELSE 'whole' END AS selection,
            CASE WHEN fragment IN ('stdout','stderr') THEN 'stream' WHEN scheme = 'log' THEN 'log' ELSE 'file' END AS what,
            COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='READ' GROUP BY selection, what`).all();
        for (const sel of ["ranged", "pattern", "whole"]) row[`read_${sel}`] = reads.filter((r) => r.selection === sel).reduce((s, r) => s + r.n, 0);
        for (const what of ["file", "stream", "log"]) row[`read_${what}`] = reads.filter((r) => r.what === what).reduce((s, r) => s + r.n, 0);

        const finds = db.prepare("SELECT coalesce(json_extract(tx,'$.matcher.dialect'),'none') AS dialect, COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='FIND' GROUP BY dialect").all();
        for (const d of DIALECTS) row[`find_${d}`] = finds.filter((r) => r.dialect === d).reduce((s, r) => s + r.n, 0);
        row.find_other = finds.filter((r) => !DIALECTS.includes(r.dialect)).reduce((s, r) => s + r.n, 0);

        // KILL targets: the journal (context curation), files (workspace cleanup), streams.
        const kills = db.prepare("SELECT json_extract(tx,'$.target.raw') AS target FROM log_entries WHERE origin='model' AND op='KILL'").all();
        row.kill_log = kills.filter((k) => /^log:/u.test(k.target ?? "")).length;
        row.kill_stream = kills.filter((k) => /^sh:/u.test(k.target ?? "")).length;
        row.kill_file = kills.length - row.kill_log - row.kill_stream;
        row.rowsRetired = db.prepare("SELECT COUNT(*) AS n FROM log_curation_effects").get().n;

        // Capacity machinery: receipts, previews, over-budget rows, pressure notices, the gauge.
        row.receipts413 = db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE status_rx = 413").get().n;
        row.overBudgetRows = db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE rx LIKE '%exceeds budget%'").get().n;
        row.previews = db.prepare("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND rx LIKE '% of % lines%'").get().n;
        let pressure = 0, maxTokens = 0, sumTokens = 0, gauged = 0, budget = null;
        for (const { packet } of db.prepare("SELECT packet FROM turn_packets WHERE packet IS NOT NULL").all()) {
            if (packet.includes("budget_pressure")) pressure++;
            const m = GAUGE.exec(packet);
            if (m) { const t = Number(m[1]); gauged++; sumTokens += t; maxTokens = Math.max(maxTokens, t); if (m[2]) budget = Number(m[2]); }
        }
        Object.assign(row, { pressurePackets: pressure, gaugedPackets: gauged, maxPacketTokens: maxTokens, meanPacketTokens: gauged ? Math.round(sumTokens / gauged) : null, budget, maxPacketShareOfBudget: budget ? maxTokens / budget : null });
        return row;
    } finally { db.close(); }
}

const rows = [];
for (const a of attempts.sort((x, y) => x.instance.localeCompare(y.instance) || x.attempt - y.attempt)) {
    if (!existsSync(join(a.run, "plurnk.db"))) { console.error(`${a.instance}/${a.attempt}: no database at ${a.run}`); continue; }
    try { rows.push(census(a)); } catch (error) { console.error(`${a.instance}/${a.attempt}: ${error.message}`); }
}

const columns = Object.keys(rows[0]);
writeFileSync(join(out, "census.tsv"), [columns.join("\t"), ...rows.map((r) => columns.map((c) => r[c] ?? "").join("\t"))].join("\n") + "\n");

const sum = (key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const runsWith = (key) => rows.filter((r) => Number(r[key]) > 0).length;
const sortedMax = rows.map((r) => r.maxPacketTokens).sort((a, b) => a - b);
const aggregate = {
    attempts: rows.length, turns: sum("turns"), modelTurns: sum("modelTurns"), noteOnlyTurns: sum("noteOnlyTurns"), packets: sum("packets"),
    modelOps: sum("modelOps"), refused: sum("refused"), ops: Object.fromEntries(OPS.map((op) => [op, sum(op)])), otherOps: sum("otherOps"),
    read: { ranged: sum("read_ranged"), pattern: sum("read_pattern"), whole: sum("read_whole"), file: sum("read_file"), stream: sum("read_stream"), log: sum("read_log") },
    find: Object.fromEntries([...DIALECTS, "other"].map((d) => [d, sum(`find_${d}`)])),
    kill: { log: sum("kill_log"), file: sum("kill_file"), stream: sum("kill_stream"), attemptsWithAnyKill: runsWith("KILL"), attemptsWithLogKill: runsWith("kill_log"), rowsRetired: sum("rowsRetired") },
    capacity: {
        receipts413: sum("receipts413"), overBudgetRows: sum("overBudgetRows"), pressurePackets: sum("pressurePackets"), previews: sum("previews"),
        budgets: [...new Set(rows.map((r) => r.budget))], gaugedPackets: sum("gaugedPackets"),
        maxPacketTokens: sortedMax.at(-1), medianMaxPacketTokens: sortedMax[Math.floor(rows.length / 2)],
        maxPacketShareOfBudget: Math.max(...rows.map((r) => r.maxPacketShareOfBudget ?? 0)),
    },
    notesPerModelTurn: sum("NOTE") / sum("modelTurns"),
};
writeFileSync(join(out, "census.json"), JSON.stringify(aggregate, null, 2) + "\n");
console.log(JSON.stringify(aggregate, null, 2));
