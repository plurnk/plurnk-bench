// {§swebench-pi} Benchmark limits and evidence, not an alternate agent loop.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drainCaptures, observeFetch } from "./pi-observer.mjs";

export default function (pi) {
    const { turnCap } = JSON.parse(readFileSync(process.env.PLURNK_PI_PROFILE, "utf8"));
    const events = join(process.env.PLURNK_PI_AGENT_DIR, "limits.jsonl");
    let turns = 0;
    pi.on("session_start", () => {
        globalThis.fetch = observeFetch(globalThis.fetch, join(process.env.PLURNK_PI_AGENT_DIR, "wire"));
    });
    pi.on("turn_start", (_event, ctx) => {
        if (++turns > turnCap) {
            appendFileSync(events, JSON.stringify({ event: "turn-cap", turnCap, at: new Date().toISOString() }) + "\n");
            ctx.abort();
        }
    });
    pi.on("agent_end", async () => {
        await drainCaptures();
    });
    pi.on("session_shutdown", async () => {
        await drainCaptures();
    });
}
