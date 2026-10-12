// Turn-by-turn read of one Plurnk run under a context cap.
// usage: node specimen.mjs <run-dir>
// For every model turn: the packet's gauge (tokens, budget, share), whether the pressure notice or the
// over-budget mandate was in the packet, the model's statements with their statuses, and what any
// KILL retired. Then totals. Reads the run's plurnk.db read-only.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [run] = process.argv.slice(2);
if (!run) { console.error("usage: node specimen.mjs <run-dir>"); process.exit(2); }
const db = new DatabaseSync(join(run, "plurnk.db"), { readOnly: true });
const GAUGE = /"name":"budget".*?"content":"(\{[^"]*?(?:\\"[^"]*?)*?\})"/u;
const unescape = (s) => s.replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");

try {
    const turns = db.prepare("SELECT id, loop_id, sequence FROM turns ORDER BY loop_id, sequence").all();
    const packets = new Map(db.prepare("SELECT loop_id, sequence, packet FROM turn_packets WHERE packet IS NOT NULL").all().map((p) => [`${p.loop_id}/${p.sequence}`, p.packet]));
    // `tx` is the statement as JSON for native operations and raw text for executions; extract only from JSON.
    const ops = db.prepare(`SELECT turn_id, op, status_rx AS status, pathname, lineMarker, weight,
        CASE WHEN json_valid(tx) THEN json_extract(tx,'$.target.raw') END AS target,
        CASE WHEN json_valid(tx) THEN json_extract(tx,'$.matcher.raw') END AS pattern,
        CASE WHEN json_valid(tx) THEN substr(json_extract(tx,'$.body'),1,90) END AS body
        FROM log_entries WHERE origin='model' ORDER BY id`).all();
    const byTurn = new Map();
    for (const o of ops) { if (!byTurn.has(o.turn_id)) byTurn.set(o.turn_id, []); byTurn.get(o.turn_id).push(o); }
    const errors = db.prepare("SELECT turn_id, op, status_rx AS status, substr(rx,1,140) AS rx FROM log_entries WHERE origin='_plurnk' AND status_rx >= 400 ORDER BY id").all();
    const errByTurn = new Map();
    for (const e of errors) { if (!errByTurn.has(e.turn_id)) errByTurn.set(e.turn_id, []); errByTurn.get(e.turn_id).push(e); }

    let budget = null, maxShare = 0, pressureTurns = 0, mandateTurns = 0, shedTurns = 0;
    console.log("turn | gauge tokens/budget (share) | flags | model statements");
    for (const t of turns) {
        const packet = packets.get(`${t.loop_id}/${t.sequence}`);
        const statements = byTurn.get(t.id) ?? [];
        if (!packet && statements.length === 0) continue;
        let gauge = "(no packet)";
        const flags = [];
        if (packet) {
            const m = GAUGE.exec(packet);
            if (m) {
                try {
                    const g = JSON.parse(unescape(m[1]));
                    budget = g.budget ?? budget;
                    const share = g.budget ? g.tokens / g.budget : null;
                    if (share !== null) maxShare = Math.max(maxShare, share);
                    gauge = `${g.tokens}/${g.budget ?? "?"}${share !== null ? ` (${Math.round(share * 100)}%)` : ""}${g.largest ? ` largest:${g.largest.length}` : ""}`;
                } catch { gauge = m[1].slice(0, 60); }
            }
            if (packet.includes("budget_pressure")) { flags.push("PRESSURE"); pressureTurns++; }
            if (packet.includes("exceeds budget")) { flags.push("OVER-BUDGET"); mandateTurns++; }
            if (/"size":\{/u.test(packet) && /bodiless|receipt/iu.test(packet)) { flags.push("receipt?"); }
        }
        const described = statements.map((s) => {
            const where = s.op === "NOTE" ? "" : ` ${s.target ?? s.pathname ?? ""}${s.lineMarker ? ` ${s.lineMarker}` : ""}${s.pattern ? ` ${s.pattern}` : ""}`;
            const body = s.op === "KILL" && s.body ? ` «${s.body.replace(/\n/gu, " ")}»` : "";
            return `${s.op}${where}${s.status !== 200 ? ` [${s.status}]` : ""}${body}`;
        });
        const errs = (errByTurn.get(t.id) ?? []).map((e) => `  ! ${e.op} ${e.status}: ${e.rx.replace(/\n/gu, " ")}`);
        console.log(`${String(t.sequence).padStart(3)} | ${gauge.padEnd(34)} | ${flags.join(",").padEnd(12)} | ${described.join(" ; ") || "(none)"}`);
        for (const e of errs) console.log(e);
    }
    const count = (sql) => db.prepare(sql).get().n;
    console.log("\n--- totals");
    console.log(`turns ${turns.length}; budget ${budget}; max packet share ${(maxShare * 100).toFixed(0)}%; pressure packets ${pressureTurns}; over-budget packets ${mandateTurns}`);
    console.log(`model statements ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model'")}, refused ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND status_rx>=400")}`);
    console.log(`KILL ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='KILL'")} (rows retired ${count("SELECT COUNT(*) AS n FROM log_curation_effects")}); NOTE ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='NOTE'")}; READ ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='READ'")} (ranged ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='READ' AND lineMarker IS NOT NULL AND lineMarker!=''")}); FIND ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='FIND'")}; sh ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='sh'")}; EDIT ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND op='EDIT'")}`);
    console.log(`413 rows ${count("SELECT COUNT(*) AS n FROM log_entries WHERE status_rx=413")}; previews ${count("SELECT COUNT(*) AS n FROM log_entries WHERE origin='model' AND rx LIKE '% of % lines%'")}`);
    const usage = db.prepare("SELECT COUNT(*) AS n, SUM(usage_input) AS input, SUM(usage_input_cache_read) AS cached, SUM(usage_output) AS output, SUM(usage_output_reasoning) AS reasoning, SUM(COALESCE(cost_usd_equivalent, cost_amount)) AS usd FROM provider_requests").get();
    console.log(`provider requests ${usage.n}: input ${usage.input} (cache read ${usage.cached}), output ${usage.output}, reasoning ${usage.reasoning}, cost $${Number(usage.usd ?? 0).toFixed(4)}`);
    for (const name of ["record.json"]) if (existsSync(join(run, name))) {
        const r = JSON.parse(readFileSync(join(run, name), "utf8"));
        console.log(`${name}: ${JSON.stringify({ status: r.finalStatus ?? r.status, turns: r.turnCount, cost: r.usage?.costUsd ?? r.cost })}`);
    }
} finally { db.close(); }
