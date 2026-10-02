// {§swebench-container-runtime} Host orchestration delegates lifecycle/network to Harbor.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { join } from "node:path";
import type { CandidateExit } from "./run.ts";

export interface ContainerRequest {
    trial: string;
    runtime: string;
    repository: string;
    agent: string;
    image: string;
    cpus: number;
    memoryMb: number;
    allowedHosts: string[];
    preflight: boolean;
    argv: string[];
    env: NodeJS.ProcessEnv;
}

export function modelHosts(env: NodeJS.ProcessEnv, preflight: boolean): string[] {
    const hosts = JSON.parse(env.PLURNK_SWEBENCH_MODEL_HOSTS ?? "[]");
    if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string" || !host.trim() || /\s|:\/\//.test(host))) {
        throw new Error("PLURNK_SWEBENCH_MODEL_HOSTS must be a JSON array of host names (not URLs)");
    }
    if (!preflight && hosts.length === 0) throw new Error("Set PLURNK_SWEBENCH_MODEL_HOSTS to the model endpoint's hosts before inference");
    return hosts;
}

export async function runContainer(request: ContainerRequest, { signal, timeoutMs, python = process.env.PLURNK_SWEBENCH_HARBOR_PYTHON ?? "python" }: {
    signal?: AbortSignal; timeoutMs?: number; python?: string;
} = {}): Promise<CandidateExit> {
    signal?.throwIfAborted();
    const stdout = createWriteStream(join(request.trial, "container.stdout.log"));
    const stderr = createWriteStream(join(request.trial, "container.stderr.log"));
    const child = spawn(python, [join(import.meta.dirname, "container.py")], { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    // Credentials are ephemeral stdin/process environment, not an on-disk request.
    child.stdin.end(JSON.stringify(request));
    let error: Error | undefined;
    let cancelled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (timeout: boolean) => {
        if (cancelled || timedOut) return;
        cancelled = !timeout;
        timedOut = timeout;
        clearTimeout(timer);
        child.kill("SIGTERM");
    };
    const cancel = () => stop(false);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    if (timeoutMs !== undefined && !cancelled) timer = setTimeout(() => stop(true), timeoutMs);
    child.once("error", (cause) => { error = cause; });
    child.stdin.once("error", (cause) => { error ??= cause; });
    try {
        const result = await new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((accept) => child.once("close", (status, signal) => accept({ status, signal })));
        await Promise.all([finished(stdout), finished(stderr)]);
        return { ...result, error, cancelled, timedOut };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
    }
}
