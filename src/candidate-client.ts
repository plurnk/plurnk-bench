// {§bench-relock} The client consumes the selected platform's public contract projection.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const run = async (args: string[], cwd: string) => (await execute("npm", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;

// npm 11 answers `pack --json` with an array of records; npm 12 keys the records by package name.
// Either envelope must carry exactly the contracts package ({§bench-relock}).
export function packedContracts(source: string): { name: string; filename: string } {
    const value: unknown = JSON.parse(source);
    const records: unknown[] = Array.isArray(value) ? value : value !== null && typeof value === "object" ? Object.values(value) : [];
    const [record] = records;
    if (records.length !== 1 || record === null || typeof record !== "object"
        || (record as { name?: unknown }).name !== "@plurnk/plurnk-contracts"
        || typeof (record as { filename?: unknown }).filename !== "string" || (record as { filename: string }).filename.length === 0) {
        throw new Error("Candidate platform did not pack its contracts");
    }
    return record as { name: string; filename: string };
}

export async function buildCandidateClient(serviceRoot: string, clientRoot: string) {
    const archives = await mkdtemp(join(tmpdir(), "plurnk-candidate-contracts-"));
    try {
        const packed = packedContracts(await run(["pack", "--workspace=@plurnk/plurnk-contracts", "--ignore-scripts", "--json", "--pack-destination", archives], serviceRoot));
        const archive = join(archives, packed.filename);
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
