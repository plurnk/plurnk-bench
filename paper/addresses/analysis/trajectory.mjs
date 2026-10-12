// Prompt-token trajectory per attempt, both arms, from an evidence release directory.
// usage: node trajectory.mjs <release-dir> <out-dir>
// Reads <release>/<arm>/trials/<instance>/attempt-N/requests.jsonl and writes:
//   attempts.tsv            one row per attempt: calls, first/max/last prompt, drops, totals
//   <arm>-by-call.dat       per call index k: n alive, median, q1, q3, mean prompt tokens
//   <arm>-by-fraction.dat   the same over the attempt's normalized position (20 bins)
//   summary.json            per-arm aggregates
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [release, out] = process.argv.slice(2);
if (!release || !out) { console.error("usage: node trajectory.mjs <release-dir> <out-dir>"); process.exit(2); }
mkdirSync(out, { recursive: true });

const FIELDS = {
    plurnk: { prompt: "inputTokens", cache: "cacheReadTokens", output: "outputTokens", reasoning: "reasoningTokens" },
    pi: { prompt: "promptTokens", cache: "cacheHitTokens", output: "completionTokens", reasoning: "reasoningTokens" },
};

const quantile = (sorted, q) => {
    if (sorted.length === 0) return NaN;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};
const stats = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { n: sorted.length, median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75), mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, max: sorted.at(-1), min: sorted[0] };
};

function attempts(arm) {
    const fields = FIELDS[arm];
    const root = join(release, arm, "trials");
    const rows = [];
    for (const instance of readdirSync(root).sort()) {
        for (const name of readdirSync(join(root, instance)).filter((n) => n.startsWith("attempt-")).sort()) {
            const dir = join(root, instance, name);
            if (!existsSync(join(dir, "requests.jsonl"))) continue;
            const requests = readFileSync(join(dir, "requests.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
                .filter((r) => Number.isFinite(r[fields.prompt]))
                .sort((a, b) => Number(a.sequence) - Number(b.sequence));
            const prompt = requests.map((r) => r[fields.prompt]);
            const cache = requests.map((r) => r[fields.cache] ?? 0);
            const output = requests.map((r) => r[fields.output] ?? 0);
            const reasoning = requests.map((r) => r[fields.reasoning] ?? 0);
            const drops = [];
            for (let k = 1; k < prompt.length; k++) if (prompt[k] < prompt[k - 1]) drops.push(prompt[k - 1] - prompt[k]);
            const verdict = existsSync(join(dir, "verdict.txt")) ? readFileSync(join(dir, "verdict.txt"), "utf8").trim() : "";
            rows.push({
                arm, instance, attempt: Number(name.slice("attempt-".length)), verdict,
                calls: prompt.length, first: prompt[0], max: Math.max(...prompt), last: prompt.at(-1),
                mean: prompt.reduce((a, b) => a + b, 0) / prompt.length,
                drops: drops.length, maxDrop: drops.length ? Math.max(...drops) : 0, dropSum: drops.reduce((a, b) => a + b, 0),
                promptTotal: prompt.reduce((a, b) => a + b, 0), cacheTotal: cache.reduce((a, b) => a + b, 0),
                outputTotal: output.reduce((a, b) => a + b, 0), reasoningTotal: reasoning.reduce((a, b) => a + b, 0),
                prompt,
            });
        }
    }
    return rows;
}

const byArm = Object.fromEntries(Object.keys(FIELDS).map((arm) => [arm, attempts(arm)]));

// attempts.tsv
const header = ["arm", "instance", "attempt", "verdict", "calls", "first", "max", "last", "mean", "drops", "maxDrop", "dropSum", "promptTotal", "cacheTotal", "outputTotal", "reasoningTotal"];
writeFileSync(join(out, "attempts.tsv"), [header.join("\t"), ...Object.values(byArm).flat().map((r) => header.map((h) => typeof r[h] === "number" ? Math.round(r[h]) : r[h]).join("\t"))].join("\n") + "\n");

// per-attempt series, for small-multiple plots
for (const [arm, rows] of Object.entries(byArm)) {
    writeFileSync(join(out, `${arm}-series.tsv`), rows.map((r) => [`${r.instance}/${r.attempt}`, ...r.prompt].join("\t")).join("\n") + "\n");
}

const summary = {};
for (const [arm, rows] of Object.entries(byArm)) {
    const maxCalls = Math.max(...rows.map((r) => r.calls));
    const byCall = [];
    for (let k = 1; k <= maxCalls; k++) {
        const alive = rows.filter((r) => r.calls >= k).map((r) => r.prompt[k - 1]);
        const s = stats(alive);
        byCall.push([k, s.n, s.median, s.q1, s.q3, s.mean].map((v) => Math.round(v)).join(" "));
    }
    writeFileSync(join(out, `${arm}-by-call.dat`), "k n median q1 q3 mean\n" + byCall.join("\n") + "\n");

    const BINS = 20;
    const byFraction = [];
    for (let b = 0; b < BINS; b++) {
        const values = [];
        for (const r of rows) {
            const lo = Math.floor((b / BINS) * r.calls), hi = Math.max(lo + 1, Math.floor(((b + 1) / BINS) * r.calls));
            for (let k = lo; k < hi && k < r.calls; k++) values.push(r.prompt[k]);
        }
        const s = stats(values);
        byFraction.push([((b + 0.5) / BINS).toFixed(3), s.n, Math.round(s.median), Math.round(s.q1), Math.round(s.q3), Math.round(s.mean)].join(" "));
    }
    writeFileSync(join(out, `${arm}-by-fraction.dat`), "x n median q1 q3 mean\n" + byFraction.join("\n") + "\n");

    const maxes = stats(rows.map((r) => r.max));
    const calls = stats(rows.map((r) => r.calls));
    const growth = stats(rows.map((r) => r.last / r.first));
    const withDrops = rows.filter((r) => r.drops > 0).length;
    const bigDrops = rows.filter((r) => r.maxDrop >= 0.5 * r.max).length;
    summary[arm] = {
        attempts: rows.length,
        calls: { median: calls.median, max: calls.max, total: rows.reduce((a, r) => a + r.calls, 0) },
        maxPrompt: { median: maxes.median, q3: maxes.q3, p90: quantile(rows.map((r) => r.max).sort((a, b) => a - b), 0.9), max: maxes.max },
        meanPromptPerCall: rows.reduce((a, r) => a + r.promptTotal, 0) / rows.reduce((a, r) => a + r.calls, 0),
        growthLastOverFirst: { median: growth.median, max: growth.max },
        attemptsWithAnyDrop: withDrops,
        attemptsWithDropOverHalfOfMax: bigDrops,
        dropsPerAttempt: rows.reduce((a, r) => a + r.drops, 0) / rows.length,
        promptTotal: rows.reduce((a, r) => a + r.promptTotal, 0),
        cacheShare: rows.reduce((a, r) => a + r.cacheTotal, 0) / rows.reduce((a, r) => a + r.promptTotal, 0),
        outputTotal: rows.reduce((a, r) => a + r.outputTotal, 0),
        reasoningTotal: rows.reduce((a, r) => a + r.reasoningTotal, 0),
    };
}
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");

for (const [arm, s] of Object.entries(summary)) {
    console.log(`${arm}: ${s.attempts} attempts, calls median ${s.calls.median} max ${s.calls.max} total ${s.calls.total}`);
    console.log(`  max prompt per attempt: median ${Math.round(s.maxPrompt.median)} q3 ${Math.round(s.maxPrompt.q3)} p90 ${Math.round(s.maxPrompt.p90)} max ${s.maxPrompt.max}`);
    console.log(`  mean prompt per call ${Math.round(s.meanPromptPerCall)}; last/first median ${s.growthLastOverFirst.median.toFixed(2)} max ${s.growthLastOverFirst.max.toFixed(2)}`);
    console.log(`  attempts with any drop ${s.attemptsWithAnyDrop}; with a drop over half of max ${s.attemptsWithDropOverHalfOfMax}; drops per attempt ${s.dropsPerAttempt.toFixed(2)}`);
    console.log(`  prompt total ${s.promptTotal} (cache share ${(s.cacheShare * 100).toFixed(1)}%), output ${s.outputTotal}, reasoning ${s.reasoningTotal}`);
}
