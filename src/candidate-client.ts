// {§bench-relock} The client consumes the selected platform's public contract projection.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const run = async (args: string[], cwd: string) => (await execute("npm", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;

export async function buildCandidateClient(serviceRoot: string, clientRoot: string) {
    const archives = await mkdtemp(join(tmpdir(), "plurnk-candidate-contracts-"));
    try {
        const packed = JSON.parse(await run(["pack", "--workspace=@plurnk/plurnk-contracts", "--ignore-scripts", "--json", "--pack-destination", archives], serviceRoot));
        if (packed.length !== 1 || packed[0].name !== "@plurnk/plurnk-contracts") throw new Error("Candidate platform did not pack its contracts");
        const archive = join(archives, packed[0].filename);
        const { projectTarball } = await import(pathToFileURL(join(serviceRoot, "scripts/package-projection.mjs")).href);
        await projectTarball(archive);
        await run(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--no-save", archive], clientRoot);
        await run(["run", "build"], clientRoot);
    } finally {
        await rm(archives, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const [serviceRoot, clientRoot] = process.argv.slice(2);
    if (!serviceRoot || !clientRoot) throw new Error("usage: candidate-client.ts <built-service-root> <client-root>");
    await buildCandidateClient(resolve(serviceRoot), resolve(clientRoot));
}
