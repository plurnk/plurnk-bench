// bench#18-adjacent: live digest sidecar. Copies the run's WAL database on a
// cadence and re-renders the digest into <runDir>/digest-live/, so the model's
// progress is readable mid-run instead of after the clock. A torn copy (rare,
// mid-write) fails that cycle loudly and the next cadence retries; the run
// itself is never touched — reads only, from a copy.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
    options: {
        run: { type: "string" },
        service: { type: "string" },
        interval: { type: "string", default: "45" },
    },
    strict: true,
});
if (values.run === undefined || values.service === undefined) {
    throw new Error("digest-live requires --run <runDir> and --service <serviceRoot>");
}
const runDir = resolve(values.run);
const serviceRoot = resolve(values.service);
const intervalMs = Number(values.interval) * 1_000;
if (!Number.isFinite(intervalMs) || intervalMs < 5_000) throw new Error("--interval must be at least 5 seconds");

const dbPath = resolve(runDir, "plurnk.db");
const outDir = resolve(runDir, "digest-live");
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));

let lastStamp = "";
process.stderr.write(`digest-live: watching ${dbPath} every ${intervalMs / 1_000}s\n`);
for (;;) {
    await sleep(intervalMs);
    if (!existsSync(dbPath)) continue;
    const stamp = ["", "-wal"].map((suffix) => {
        try { const s = statSync(dbPath + suffix); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; }
    }).join("|");
    if (stamp === lastStamp) continue;

    // Scratch lives beside the run so the final rename is same-filesystem atomic.
    const scratch = mkdtempSync(resolve(runDir, ".digest-live-"));
    try {
        copyFileSync(dbPath, resolve(scratch, "plurnk.db"));
        for (const suffix of ["-wal", "-shm"]) {
            if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, resolve(scratch, `plurnk.db${suffix}`));
        }
        const rendered = spawnSync(process.execPath, [
            "--conditions=plurnk-dev",
            resolve(serviceRoot, "plurnk-core", "bin", "digest.ts"),
            resolve(scratch, "plurnk.db"),
            resolve(scratch, "digest"),
        ], { cwd: serviceRoot, encoding: "utf8" });
        if (rendered.status !== 0) {
            process.stderr.write(`digest-live: render failed (status ${rendered.status}); retrying next cycle\n${(rendered.stderr ?? "").slice(-400)}\n`);
            continue;
        }
        rmSync(outDir + ".old", { recursive: true, force: true });
        if (existsSync(outDir)) renameSync(outDir, outDir + ".old");
        renameSync(resolve(scratch, "digest"), outDir);
        rmSync(outDir + ".old", { recursive: true, force: true });
        lastStamp = stamp;
        process.stderr.write(`digest-live: refreshed ${outDir} at ${new Date().toISOString()}\n`);
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
