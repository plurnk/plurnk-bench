// {§swebench-evaluator} Host orchestration delegates lifecycle/network to Harbor.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, createWriteStream, openSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
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
    loopbackPorts?: number[];
    preflight: boolean;
    argv: string[];
    env: NodeJS.ProcessEnv;
}

export function loopbackPorts(env: NodeJS.ProcessEnv, urls: (string | undefined)[] = []): number[] {
    const model = env.PLURNK_MODEL?.toLowerCase();
    const child = env.PLURNK_MODEL_CHILD?.toLowerCase();
    const candidates = [...urls];
    for (const [key, value] of Object.entries(env)) {
        if (!value) continue;
        if (key.startsWith("PLURNK_BASEURL_")) {
            const alias = key.slice("PLURNK_BASEURL_".length).toLowerCase();
            if (!model || alias === model || alias === child) candidates.push(value);
        } else if (/^(?:PLURNK_PROVIDERS_PROVIDER_[A-Z0-9_]+|[A-Z0-9_]+)_BASE_URL$/.test(key)) {
            candidates.push(value);
        }
    }
    const ports = new Set<number>();
    for (const candidate of candidates) {
        if (!candidate) continue;
        let url: URL;
        try { url = new URL(candidate); } catch { continue; }
        if ((url.protocol === "http:" || url.protocol === "https:")
            && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")) {
            const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
            if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
        }
    }
    return [...ports].sort((a, b) => a - b);
}

export function modelHosts(env: NodeJS.ProcessEnv, preflight: boolean, urls: (string | undefined)[] = []): string[] {
    const hosts = JSON.parse(env.PLURNK_SWEBENCH_MODEL_HOSTS ?? "[]");
    if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string" || !host.trim() || /\s|:\/\//.test(host))) {
        throw new Error("PLURNK_SWEBENCH_MODEL_HOSTS must be a JSON array of host names (not URLs)");
    }
    const external = hosts.filter((host) => host !== "127.0.0.1" && host !== "localhost");
    const loopback = urls.length > 0 ? loopbackPorts({}, urls) : loopbackPorts(env);
    if (!preflight && external.length === 0 && loopback.length === 0) {
        throw new Error("Set PLURNK_SWEBENCH_MODEL_HOSTS to the model endpoint's hosts before inference");
    }
    return external;
}

export async function runContainer(request: ContainerRequest, {
    signal, timeoutMs, python = process.env.PLURNK_SWEBENCH_HARBOR_PYTHON ?? "python",
    resolverConfig = process.env.PLURNK_SWEBENCH_RESOLV_CONF ?? "",
}: {
    signal?: AbortSignal; timeoutMs?: number; python?: string; resolverConfig?: string;
} = {}): Promise<CandidateExit> {
    signal?.throwIfAborted();
    const ports = request.preflight ? [] : (request.loopbackPorts ?? loopbackPorts(request.env));
    let agentFd: number | undefined;
    const bridges: Server[] = [];
    const sockets = new Set<Socket>();
    try {
        if (ports.length > 0) {
            // Address the trial's agent directory via /proc/self/fd so host path length never hits UNIX_PATH_MAX.
            agentFd = openSync(request.agent, constants.O_RDONLY | constants.O_DIRECTORY);
            for (const port of ports) {
                rmSync(join(request.agent, `loopback-${port}.sock`), { force: true });
                const server = createServer((client) => {
                    const upstream = connect({ host: "127.0.0.1", port });
                    sockets.add(client);
                    sockets.add(upstream);
                    const cleanup = () => {
                        sockets.delete(client);
                        sockets.delete(upstream);
                        client.destroy();
                        upstream.destroy();
                    };
                    client.on("error", cleanup);
                    upstream.on("error", cleanup);
                    client.on("close", () => sockets.delete(client));
                    upstream.on("close", () => sockets.delete(upstream));
                    client.pipe(upstream);
                    upstream.pipe(client);
                });
                bridges.push(server);
                server.listen(`/proc/self/fd/${agentFd}/loopback-${port}.sock`);
                await once(server, "listening");
            }
            writeFileSync(join(request.agent, "loopback.mjs"), [
                'import { once } from "node:events";',
                'import { connect, createServer } from "node:net";',
                `for (const port of ${JSON.stringify(ports)}) {`,
                '    for (const host of ["127.0.0.1", "::1"]) {',
                "        const server = createServer((client) => {",
                '            const upstream = connect(`/var/lib/plurnk/loopback-${port}.sock`);',
                "            const close = () => { client.destroy(); upstream.destroy(); };",
                '            client.on("error", close);',
                '            upstream.on("error", close);',
                "            client.pipe(upstream);",
                "            upstream.pipe(client);",
                "        });",
                "        server.unref();",
                "        try {",
                '            server.listen({ host, port, ipv6Only: host === "::1" });',
                '            await once(server, "listening");',
                "        } catch (error) {",
                '            if (host === "127.0.0.1") throw error;',
                "        }",
                "    }",
                "}",
            ].join("\n") + "\n");
        }
        const stdout = createWriteStream(join(request.trial, "container.stdout.log"));
        const stderr = createWriteStream(join(request.trial, "container.stderr.log"));
        const child = spawn(python, [join(import.meta.dirname, "container.py")], { stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.pipe(stdout);
        child.stderr.pipe(stderr);
        // Credentials are ephemeral stdin/process environment, not an on-disk request.
        child.stdin.end(JSON.stringify({ ...request, ...(ports.length > 0 ? { loopbackPorts: ports } : {}), resolverConfig }));
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
    } finally {
        for (const socket of sockets) socket.destroy();
        await Promise.all(bridges.map((server) => new Promise<void>((accept) => server.close(() => accept()))));
        if (agentFd !== undefined) closeSync(agentFd);
        if (ports.length > 0) {
            rmSync(join(request.agent, "loopback.mjs"), { force: true });
            for (const port of ports) rmSync(join(request.agent, `loopback-${port}.sock`), { force: true });
        }
    }
}
