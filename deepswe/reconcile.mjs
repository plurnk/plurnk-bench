// Billed-truth reconciliation for a corpus run (#15/#473 discipline): the ONLY
// $/win and comparative-cost claims come from this decomposition against the
// provider dashboard's billed figure, never from catalog estimates alone.
// Usage: node deepswe/reconcile.mjs <run-log-or-job-dir> [billed-usd]
import fs from "node:fs";
import { resolve, join } from "node:path";

const [, , target, billedArg] = process.argv;
if (!target) throw new Error("usage: reconcile.mjs <run-log-or-job-dir> [billed-usd]");

const recordDirs = [];
const stat = fs.statSync(target);
if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
        const dir = join(target, entry);
        if (fs.existsSync(join(dir, "record.json"))) recordDirs.push(dir);
    }
} else {
    const log = fs.readFileSync(target, "utf8");
    for (const [, dir] of log.matchAll(/^published \S+ \((?:pass|fail)\) → (\S+)/gm)) recordDirs.push(dir);
}
if (recordDirs.length === 0) throw new Error(`no records found under ${target}`);

let pass = 0, fail = 0, estimatedUsd = 0, requiemUsd = 0, requests = 0, errors = 0;
let inputTok = 0, cacheTok = 0, outputTok = 0, usageless = 0;
for (const dir of recordDirs) {
    const j = JSON.parse(fs.readFileSync(join(dir, "record.json"), "utf8"));
    if (j.reward === 1) pass++; else fail++;
    estimatedUsd += Number(j.usage?.accounting?.costUsd ?? 0) || 0;
    requiemUsd += Number(j.requiem?.costUsd ?? 0) || 0;
    for (const r of j.usage?.accounting?.requests ?? []) {
        requests++;
        if (r.outcome === "error") { errors++; continue; }
        const u = r.usage;
        if (!u || u.totalTokens === undefined) { usageless++; continue; }
        inputTok += u.inputTokens ?? 0;
        cacheTok += u.inputTokenDetails?.cacheReadTokens ?? 0;
        outputTok += u.outputTokens ?? 0;
    }
}

const lines = [
    `records: ${recordDirs.length} (pass ${pass}, fail ${fail})`,
    `wire: ${requests} requests · ${errors} errors (${requests ? Math.round((100 * errors) / requests) : 0}%) · ${usageless} usage-less non-error`,
    `visible tokens: input ${inputTok} (${cacheTok} cache-read) · output ${outputTok} — reasoning UNREPORTED by provider when absent from usage`,
    `estimated (catalog rates, records only — excludes anything unpublished): $${estimatedUsd.toFixed(2)} candidate + $${requiemUsd.toFixed(2)} requiem`,
];
if (billedArg !== undefined) {
    const billed = Number(billedArg);
    if (!Number.isFinite(billed) || billed < 0) throw new Error("billed-usd must be a non-negative number");
    const residual = billed - estimatedUsd;
    lines.push(
        `provider-billed (operator dashboard): $${billed.toFixed(2)}`,
        `residual over visible estimate: $${residual.toFixed(2)} — unrecorded server-side spend: hidden reasoning, errored/usage-less processing, and any coverage gap`,
        `BILLED $/win: ${pass > 0 ? `$${(billed / pass).toFixed(2)}` : "no wins"} (the only citable figure)`,
    );
} else {
    lines.push("no billed figure supplied — comparative claims FORBIDDEN until reconciled against the provider dashboard");
}
console.log(lines.join("\n"));
