// {§swebench-evaluator} Host-side OS-owned flock GPU slot leasing for containerized local model trials.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { benchmarksHome } from "../src/host-paths.ts";

export interface SlotLease {
    readonly port: number;
    readonly slot: number;
    readonly totalSlots: number;
    release(): Promise<void>;
}

export interface SlotLeaseSet {
    readonly leases: readonly SlotLease[];
    release(): Promise<void>;
}

export interface ProbeLocalSlotsOptions {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly slotsOverride?: string | undefined;
}

const parseSlotsOverride = (raw: string | undefined): number | null | undefined => {
    if (raw === undefined || raw.trim() === "") return undefined;
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) {
        throw new Error(`PLURNK_BENCH_LOCAL_SLOTS must be 0 or a positive integer (received ${JSON.stringify(raw)})`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`PLURNK_BENCH_LOCAL_SLOTS must be 0 or a positive integer (received ${JSON.stringify(raw)})`);
    }
    return parsed === 0 ? null : parsed;
};

/**
 * {§swebench-evaluator} Discover finite local-server slot concurrency (`total_slots` from llama-server `/props`),
 * or honor an explicit `PLURNK_BENCH_LOCAL_SLOTS` override (`0` disables host-side slot leasing).
 */
export async function probeLocalSlots(
    port: number,
    options: ProbeLocalSlotsOptions = {},
): Promise<number | null> {
    const override = parseSlotsOverride(
        options.slotsOverride !== undefined ? options.slotsOverride : process.env.PLURNK_BENCH_LOCAL_SLOTS,
    );
    if (override !== undefined) return override;

    options.signal?.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? 2_000);
    const signal = options.signal === undefined
        ? timeoutSignal
        : AbortSignal.any([options.signal, timeoutSignal]);
    try {
        const response = await fetch(`http://127.0.0.1:${port}/props`, {
            method: "GET",
            headers: { accept: "application/json" },
            signal,
        });
        if (!response.ok) return null;
        const body = await response.json().catch(() => null) as { total_slots?: unknown } | null;
        if (body !== null && typeof body.total_slots === "number" && Number.isSafeInteger(body.total_slots) && body.total_slots > 0) {
            return body.total_slots;
        }
        return null;
    } catch {
        options.signal?.throwIfAborted();
        return null;
    }
}

interface LockHandle {
    release(): Promise<void>;
}

const tryFlock = (
    lockPath: string,
    blocking: boolean,
    signal?: AbortSignal,
): Promise<LockHandle | null> => new Promise((resolveLock, rejectLock) => {
    if (signal?.aborted) {
        rejectLock(signal.reason ?? new Error("slot lease aborted"));
        return;
    }
    const args = [
        ...(blocking ? [] : ["--nonblock"]),
        "--exclusive",
        lockPath,
        "sh",
        "-c",
        "printf ok; exec cat",
    ];
    const child = spawn("flock", args, { stdio: ["pipe", "pipe", "ignore"] });
    let acquired = false;
    let settled = false;
    let released = false;
    let exitPromise: Promise<void> | undefined;
    let stdout = "";

    const cleanupSignal = () => {
        signal?.removeEventListener("abort", onAbort);
    };

    const waitForExit = (): Promise<void> => {
        if (exitPromise !== undefined) return exitPromise;
        if (child.exitCode !== null || child.signalCode !== null) {
            exitPromise = Promise.resolve();
            return exitPromise;
        }
        exitPromise = new Promise<void>((accept) => {
            const killTimer = setTimeout(() => {
                if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            }, 2_000);
            killTimer.unref();
            child.once("close", () => {
                clearTimeout(killTimer);
                accept();
            });
        });
        return exitPromise;
    };

    const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        cleanupSignal();
        const exiting = waitForExit();
        try { child.stdin.end(); } catch { /* pipe already closed */ }
        if (child.exitCode === null && child.signalCode === null) {
            child.stdin.destroy();
        }
        await exiting;
    };

    const onAbort = () => {
        if (acquired || settled) return;
        settled = true;
        cleanupSignal();
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        rejectLock(signal?.reason ?? new Error("slot lease aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        if (acquired || settled) return;
        stdout += chunk;
        if (stdout.includes("ok")) {
            acquired = true;
            settled = true;
            cleanupSignal();
            resolveLock({ release });
        }
    });

    child.once("error", (error) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        rejectLock(error);
    });

    child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanupSignal();
        if (!blocking && code !== 0) {
            resolveLock(null);
            return;
        }
        rejectLock(new Error(`flock ${lockPath} exited ${code ?? "signal"} before acquiring slot`));
    });
});

export async function acquirePortSlot(
    port: number,
    totalSlots: number,
    options: { readonly slotRoot?: string; readonly signal?: AbortSignal; readonly pollMs?: number } = {},
): Promise<SlotLease> {
    if (!Number.isSafeInteger(totalSlots) || totalSlots <= 0) {
        throw new Error(`totalSlots must be a positive integer (received ${totalSlots})`);
    }
    const root = options.slotRoot ?? join(benchmarksHome(), "cache", "gpu-slots");
    const portDir = join(root, String(port));
    await mkdir(portDir, { recursive: true });

    if (totalSlots === 1) {
        const handle = await tryFlock(join(portDir, "slot-0.lock"), true, options.signal);
        if (handle === null) throw new Error(`unexpected non-blocking refusal acquiring slot 0 on port ${port}`);
        return { port, slot: 0, totalSlots, release: handle.release };
    }

    const pollMs = options.pollMs ?? 250;
    for (;;) {
        options.signal?.throwIfAborted();
        for (let slot = 0; slot < totalSlots; slot += 1) {
            const handle = await tryFlock(join(portDir, `slot-${slot}.lock`), false, options.signal);
            if (handle !== null) {
                return { port, slot, totalSlots, release: handle.release };
            }
        }
        await delay(pollMs, undefined, { signal: options.signal });
    }
}

export async function acquireLoopbackSlotLeases(
    ports: readonly number[],
    options: {
        readonly slotRoot?: string;
        readonly signal?: AbortSignal;
        readonly pollMs?: number;
        readonly probe?: (port: number, probeOptions?: ProbeLocalSlotsOptions) => Promise<number | null>;
        readonly slotsOverride?: string | undefined;
    } = {},
): Promise<SlotLeaseSet> {
    const orderedPorts = [...new Set(ports)].sort((a, b) => a - b);
    const probe = options.probe ?? probeLocalSlots;
    const acquired: SlotLease[] = [];
    const releaseAll = async () => {
        for (const lease of [...acquired].reverse()) {
            await lease.release();
        }
    };
    try {
        for (const port of orderedPorts) {
            const totalSlots = await probe(port, {
                signal: options.signal,
                ...(options.slotsOverride === undefined ? {} : { slotsOverride: options.slotsOverride }),
            });
            if (totalSlots === null) continue;
            acquired.push(await acquirePortSlot(port, totalSlots, {
                slotRoot: options.slotRoot,
                signal: options.signal,
                pollMs: options.pollMs,
            }));
        }
    } catch (error) {
        await releaseAll();
        throw error;
    }
    return {
        leases: Object.freeze(acquired),
        release: releaseAll,
    };
}
