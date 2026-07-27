import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

export interface SourceCandidate {
    archivePath: string;
    commit: string;
    sha256: string;
}

export const sourceCandidateLine = (port: number, candidate: SourceCandidate): string =>
    `${port}\t${candidate.commit}\t${candidate.sha256}`;

const git = (root: string, ...args: string[]): string => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
    }
    return result.stdout.trim();
};

export const prepareSourceCandidate = (source: string): SourceCandidate => {
    const requested = realpathSync(source);
    const root = realpathSync(git(requested, "rev-parse", "--show-toplevel"));
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string };
    if (packageJson.name !== "@plurnk/monorepo") {
        throw new Error(`${root} is not the plurnk-service monorepo`);
    }
    const changes = git(root, "status", "--porcelain=v1", "--untracked-files=all");
    if (changes !== "") {
        throw new Error(`source candidate must be a clean Git commit:\n${changes}`);
    }

    const commit = git(root, "rev-parse", "HEAD");
    const directory = mkdtempSync(join(tmpdir(), "plurnk-bench-source-"));
    const archivePath = join(directory, "plurnk-service.tar");
    const archived = spawnSync(
        "git",
        ["-C", root, "archive", "--format=tar", "--output", archivePath, commit],
        { encoding: "utf8" },
    );
    if (archived.status !== 0) {
        rmSync(directory, { recursive: true, force: true });
        throw new Error(archived.stderr.trim() || "git archive failed");
    }
    const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    return { archivePath, commit, sha256 };
};

export const serveSourceCandidate = (
    candidate: SourceCandidate,
): Promise<{ port: number; close: () => Promise<void> }> => new Promise((resolve, reject) => {
    const archiveName = basename(candidate.archivePath);
    const size = statSync(candidate.archivePath).size;
    const server: Server = createServer((request, response) => {
        if (request.method !== "GET" || request.url !== `/${archiveName}`) {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, {
            "content-length": size,
            "content-type": "application/x-tar",
        });
        createReadStream(candidate.archivePath).pipe(response);
    });
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            reject(new Error("source candidate server did not bind a TCP port"));
            return;
        }
        resolve({
            port: address.port,
            close: () => new Promise<void>((done, failed) => {
                server.close((error) => error === undefined ? done() : failed(error));
            }),
        });
    });
});

if (import.meta.main) {
    const [source] = process.argv.slice(2);
    if (source === undefined) {
        process.stderr.write("usage: node deepswe/source-candidate.ts <plurnk-service-root>\n");
        process.exit(1);
    }
    let candidate: SourceCandidate | undefined;
    let close: (() => Promise<void>) | undefined;
    const cleanup = async (): Promise<void> => {
        await close?.();
        if (candidate !== undefined) {
            rmSync(dirname(candidate.archivePath), { recursive: true, force: true });
        }
    };
    try {
        candidate = prepareSourceCandidate(source);
        const server = await serveSourceCandidate(candidate);
        close = server.close;
        process.stdout.write(`${sourceCandidateLine(server.port, candidate)}\n`);
        for (const signal of ["SIGINT", "SIGTERM"] as const) {
            process.once(signal, () => {
                void cleanup().finally(() => process.exit(0));
            });
        }
    } catch (error) {
        await cleanup();
        process.stderr.write(`${(error as Error).message}\n`);
        process.exit(1);
    }
}
