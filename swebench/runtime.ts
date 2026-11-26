// {§swebench-evaluator} Immutable, installed artifacts, never a source-tree mount.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { benchmarksHome } from "../src/host-paths.ts";
import { buildCandidateClient } from "../src/candidate-client.ts";
import { packRecords } from "../src/npm-pack.ts";

const execute = promisify(execFile);
const run = async (command: string, args: string[], cwd: string) => (await execute(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const adapterFiles = ["runner.mjs", "pi-extension.mjs", "pi-observer.mjs"];
type SourceHeadRecord = { readonly head?: string };
type Input = { kind: "plurnk"; serviceRoot: string; clientRoot: string; sources: unknown }
    | { kind: "pi"; piRoot: string; version: string };
type ResolvedPlurnkIdentity = {
    kind: "plurnk";
    serviceHead: string;
    clientHead: string;
    node: string;
    nodeSha256: string;
    adapter: Record<string, string>;
};
type ResolvedPiIdentity = {
    kind: "pi";
    version: string;
    node: string;
    nodeSha256: string;
    adapter: Record<string, string>;
};
type BuildSpec =
    | { readonly kind: "plurnk"; readonly identity: ResolvedPlurnkIdentity; readonly serviceRoot: string; readonly clientRoot: string; readonly sources: unknown }
    | { readonly kind: "pi"; readonly identity: ResolvedPiIdentity; readonly piRoot: string };

const resolveHead = async (root: string, candidate?: string): Promise<string> =>
    typeof candidate === "string" && candidate.trim().length > 0
        ? candidate.trim()
        : (await run("git", ["rev-parse", "HEAD"], root)).trim();

/**
 * {§swebench-evaluator} Materialize a disposable detached git worktree of `commitSha` beside `stageDir`,
 * copying `node_modules` (root and nested workspaces) with symlinks intact so builds never mutate the live checkout.
 */
export async function withBuildWorktree<T>(
    repositoryRoot: string,
    commitSha: string,
    worktreeDir: string,
    work: (worktree: string) => Promise<T>,
): Promise<T> {
    await run("git", ["worktree", "add", "--detach", "--quiet", worktreeDir, commitSha], repositoryRoot);
    try {
        const rootModules = join(repositoryRoot, "node_modules");
        if (existsSync(rootModules)) {
            await run("cp", ["-a", rootModules, join(worktreeDir, "node_modules")], repositoryRoot);
        }
        const entries = await readdir(repositoryRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
            const nestedModules = join(repositoryRoot, entry.name, "node_modules");
            const targetWorkspace = join(worktreeDir, entry.name);
            if (existsSync(nestedModules) && existsSync(targetWorkspace)) {
                await run("cp", ["-a", nestedModules, join(targetWorkspace, "node_modules")], repositoryRoot);
            }
        }
        return await work(worktreeDir);
    } finally {
        await run("git", ["worktree", "remove", "--force", worktreeDir], repositoryRoot).catch(() => undefined);
        await run("git", ["worktree", "prune"], repositoryRoot).catch(() => undefined);
    }
}

export async function prepareRuntime(input: Input) {
    if (process.platform !== "linux" || process.arch !== "x64") {
        throw new Error("SWE-bench's pinned x86_64 Linux images require a matching Linux x64 Node/npm host runtime");
    }
    const common = {
        node: process.version,
        nodeSha256: sha256(await readFile(process.execPath)),
        adapter: Object.fromEntries(await Promise.all(["runtime.ts", "../src/candidate-client.ts", "../src/npm-pack.ts", ...adapterFiles].map(async (name) =>
            [name, sha256(await readFile(join(import.meta.dirname, name)))]))),
    };
    let spec: BuildSpec;
    if (input.kind === "plurnk") {
        const sources = input.sources as { service?: SourceHeadRecord; client?: SourceHeadRecord } | undefined;
        const serviceHead = await resolveHead(input.serviceRoot, sources?.service?.head);
        const clientHead = await resolveHead(input.clientRoot, sources?.client?.head);
        spec = {
            kind: "plurnk",
            identity: { kind: "plurnk", serviceHead, clientHead, ...common },
            serviceRoot: resolve(input.serviceRoot),
            clientRoot: resolve(input.clientRoot),
            sources: input.sources,
        };
    } else {
        spec = {
            kind: "pi",
            identity: { kind: "pi", version: input.version, ...common },
            piRoot: resolve(input.piRoot),
        };
    }
    const root = join(benchmarksHome(), "cache", "swebench-runtimes");
    await mkdir(root, { recursive: true });
    const target = join(root, sha256(JSON.stringify(spec.identity)));
    // OS-owned lock releases on failure; parallel trials cannot observe a partial install.
    await run("flock", ["--exclusive", `${target}.lock`, process.execPath, import.meta.filename,
        "--build", target, JSON.stringify(spec)], import.meta.dirname);
    return { path: target, provenance: JSON.parse(await readFile(join(target, "runtime.json"), "utf8")) };
}

async function build(target: string, spec: BuildSpec) {
    try {
        await readFile(join(target, "runtime.json"));
        return;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const stage = await mkdtemp(`${target}-stage-`);
    try {
        const archives = join(stage, "archives");
        await mkdir(archives);
        const packages: { name: string; version: string; file: string }[] = [];
        const pack = async (cwd: string, args: string[] = []) => {
            const results = packRecords(await run("npm", ["pack", ...args, "--ignore-scripts", "--json", "--pack-destination", archives], cwd));
            packages.push(...results.map(({ name, version, filename }) => ({ name, version, file: join(archives, filename) })));
        };
        if (spec.kind === "plurnk") {
            const { serviceHead, clientHead } = spec.identity;
            await withBuildWorktree(spec.serviceRoot, serviceHead, join(stage, "service-wt"), async (serviceWt) => {
                await run("npm", ["run", "build"], serviceWt);
                await withBuildWorktree(spec.clientRoot, clientHead, join(stage, "client-wt"), async (clientWt) => {
                    await buildCandidateClient(serviceWt, clientWt);
                    await pack(serviceWt, ["--workspaces"]);
                    const projectionScript = existsSync(join(serviceWt, "scripts/lib/package-projection.mjs"))
                        ? join(serviceWt, "scripts/lib/package-projection.mjs")
                        : join(serviceWt, "scripts/package-projection.mjs");
                    const { projectTarball } = await import(pathToFileURL(projectionScript).href);
                    for (const { file } of packages) await projectTarball(file);
                    await pack(clientWt);
                });
                await copyFile(join(serviceWt, "plurnk-core/.env.test"), join(stage, ".env.test"));
            });
        } else {
            // Pack the exact installed stock Pi; the profile's version is checked by its caller.
            await pack(spec.piRoot);
        }
        await json(join(stage, "package.json"), { name: "benchmark-runtime", private: true, type: "module" });
        await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...packages.map(({ file }) => file)], stage);
        const artifacts = await Promise.all(packages.map(async ({ name, version, file }) =>
            ({ name, version, sha256: sha256(await readFile(file)) })));
        await mkdir(join(stage, "bin"));
        await copyFile(process.execPath, join(stage, "bin/node"));
        const npmRoot = (await run("npm", ["root", "--global"], stage)).trim();
        await cp(join(npmRoot, "npm"), join(stage, "npm"), { recursive: true });
        await symlink("../npm/bin/npm-cli.js", join(stage, "bin/npm"));
        await symlink("../npm/bin/npx-cli.js", join(stage, "bin/npx"));
        for (const name of adapterFiles) await copyFile(join(import.meta.dirname, name), join(stage, name));
        await json(join(stage, "runtime.json"), {
            ...spec.identity,
            ...(spec.kind === "plurnk" ? { serviceRoot: spec.serviceRoot, clientRoot: spec.clientRoot, sources: spec.sources } : { piRoot: spec.piRoot }),
            artifacts,
            lockSha256: sha256(await readFile(join(stage, "package-lock.json"))),
        });
        await rm(archives, { recursive: true });
        await rename(stage, target);
    } finally { await rm(stage, { recursive: true, force: true }); }
}

const NATIVE_ADAPTER_URLS: Readonly<Record<string, string>> = {
    openai: "https://api.openai.com/v1",
    groq: "https://api.groq.com/openai/v1",
    cerebras: "https://api.cerebras.ai/v1",
    mistral: "https://api.mistral.ai/v1",
    togetherai: "https://api.together.xyz/v1",
    deepinfra: "https://api.deepinfra.com/v1/openai",
    openrouter: "https://openrouter.ai/api/v1",
    xai: "https://api.x.ai/v1",
    google: "https://generativelanguage.googleapis.com/v1beta",
    anthropic: "https://api.anthropic.com",
};

export async function resolveRouteModelUrls(serviceRoot: string, model: string, env: NodeJS.ProcessEnv): Promise<string[]> {
    const require = createRequire(join(serviceRoot, "package.json"));
    const { resolveActiveRoute } = await import(pathToFileURL(require.resolve("@plurnk/plurnk-aliases")).href);
    const { lookupProvider } = await import(pathToFileURL(require.resolve("@plurnk/plurnk-models")).href);
    const merged: NodeJS.ProcessEnv = { ...env, PLURNK_MODEL: model };
    const route = resolveActiveRoute(merged);
    if (!route) return [];
    const prefix = String(route.provider).replaceAll(/[^A-Za-z0-9]/g, "_").toUpperCase();
    const provider = lookupProvider(route.provider);
    const region = merged.AWS_REGION ?? merged.AWS_DEFAULT_REGION ?? "us-east-1";
    const nativeUrl = provider?.adapter === "amazon-bedrock"
        ? `https://bedrock-runtime.${region}.amazonaws.com`
        : (provider ? NATIVE_ADAPTER_URLS[provider.adapter] : undefined);
    const rawUrl: string | undefined = route.baseUrl
        ?? merged[`PLURNK_PROVIDERS_PROVIDER_${prefix}_BASE_URL`]
        ?? merged[`${prefix}_BASE_URL`]
        ?? provider?.api
        ?? nativeUrl;
    if (!rawUrl) return [];
    const expanded = rawUrl.replaceAll(/\$\{([A-Z0-9_]+)\}/g, (_match: string, name: string) => merged[name] ?? "");
    return [expanded];
}

export async function plurnkEnvironment(serviceRoot: string, model: string, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    const require = createRequire(join(serviceRoot, "package.json"));
    const { resolveActiveRoute } = await import(pathToFileURL(require.resolve("@plurnk/plurnk-aliases")).href);
    const { lookupProvider } = await import(pathToFileURL(require.resolve("@plurnk/plurnk-models")).href);
    const route = resolveActiveRoute({ ...env, PLURNK_MODEL: model });
    if (!route) throw new Error("No benchmark model selected");
    const prefix = route.provider.replaceAll(/[^A-Za-z0-9]/g, "_").toUpperCase();
    const configuredCredential = env[`PLURNK_PROVIDERS_PROVIDER_${prefix}_API_KEY_ENV`]?.trim();
    const credentials = configuredCredential ? [configuredCredential] : lookupProvider(route.provider)?.env ?? [];
    return Object.fromEntries(Object.entries({ ...env, PLURNK_MODEL: model }).filter(([key, value]) =>
        value !== undefined && (/^PLURNK_(?:MODEL(?:_|$)|BASEURL_|PROVIDERS_|SERVICE_|EXECS_)/.test(key)
            || key === `${prefix}_BASE_URL` || credentials.includes(key))));
}

export async function installedPiRoot(executable: string) {
    const { realpath } = await import("node:fs/promises");
    let directory = dirname(await realpath(executable));
    while (directory !== dirname(directory)) {
        try {
            const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
            if (manifest.bin?.pi) return directory;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        directory = dirname(directory);
    }
    throw new Error("Pi executable has no owning npm package");
}

if (import.meta.main) {
    if (process.argv[2] !== "--build") throw new Error("Runtime construction is owned by prepareRuntime");
    await build(resolve(process.argv[3]), JSON.parse(process.argv[4]));
}
