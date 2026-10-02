// {§swebench-container-runtime} Immutable, installed artifacts, never a source-tree mount.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { benchmarksHome } from "../src/host-paths.ts";

const execute = promisify(execFile);
const run = async (command: string, args: string[], cwd: string) => (await execute(command, args, { cwd, maxBuffer: 32 * 1024 * 1024 })).stdout;
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + "\n");
const adapterFiles = ["runner.mjs", "pi-extension.mjs", "pi-observer.mjs"];
type Input = { kind: "plurnk"; serviceRoot: string; clientRoot: string; sources: unknown }
    | { kind: "pi"; piRoot: string; version: string };
type Identity = Input & { node: string; nodeSha256: string; adapter: Record<string, string> };

export async function prepareRuntime(input: Input) {
    if (process.platform !== "linux" || process.arch !== "x64") {
        throw new Error("SWE-bench's pinned x86_64 Linux images require a matching Linux x64 Node/npm host runtime");
    }
    const identity = {
        ...input, node: process.version, nodeSha256: sha256(await readFile(process.execPath)),
        adapter: Object.fromEntries(await Promise.all(["runtime.ts", ...adapterFiles].map(async (name) =>
            [name, sha256(await readFile(join(import.meta.dirname, name)))]))),
    };
    const root = join(benchmarksHome(), "cache", "swebench-runtimes");
    await mkdir(root, { recursive: true });
    const target = join(root, sha256(JSON.stringify(identity)));
    // OS-owned lock releases on failure; parallel trials cannot observe a partial install.
    await run("flock", ["--exclusive", `${target}.lock`, process.execPath, import.meta.filename,
        "--build", target, JSON.stringify(identity)], import.meta.dirname);
    return { path: target, provenance: JSON.parse(await readFile(join(target, "runtime.json"), "utf8")) };
}

async function build(target: string, identity: Identity) {
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
            const results = JSON.parse(await run("npm", ["pack", ...args, "--ignore-scripts", "--json", "--pack-destination", archives], cwd));
            packages.push(...results.map((entry: { name: string; version: string; filename: string }) => ({ name: entry.name, version: entry.version, file: join(archives, entry.filename) })));
        };
        if (identity.kind === "plurnk") {
            await run("npm", ["run", "build"], identity.serviceRoot);
            await run("npm", ["run", "build"], identity.clientRoot);
            await pack(identity.serviceRoot, ["--workspaces"]);
            const { projectTarball } = await import(pathToFileURL(join(identity.serviceRoot, "scripts/package-projection.mjs")).href);
            for (const { file } of packages) await projectTarball(file);
            await pack(identity.clientRoot);
            await copyFile(join(identity.serviceRoot, "plurnk-core/.env.test"), join(stage, ".env.test"));
        } else {
            // Pack the exact installed stock Pi; the profile's version is checked by its caller.
            await pack(identity.piRoot);
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
        await json(join(stage, "runtime.json"), { ...identity, artifacts,
            lockSha256: sha256(await readFile(join(stage, "package-lock.json"))),
        });
        await rm(archives, { recursive: true });
        await rename(stage, target);
    } finally { await rm(stage, { recursive: true, force: true }); }
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
