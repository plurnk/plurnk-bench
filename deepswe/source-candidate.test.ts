import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { prepareSourceCandidate, serveSourceCandidate } from "./source-candidate.ts";

const git = (root: string, ...args: string[]): void => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
};

const repository = (): string => {
    const root = mkdtempSync(join(tmpdir(), "plurnk-bench-candidate-test-"));
    git(root, "init", "-q");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "core.hooksPath", "/dev/null");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@plurnk/monorepo" }));
    writeFileSync(join(root, "source.txt"), "candidate\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "test: create candidate");
    return root;
};

test("[§config-source-candidate] candidate is an exact, hashed clean Git archive", async () => {
    const root = repository();
    let archiveDirectory: string | undefined;
    try {
        const candidate = prepareSourceCandidate(root);
        archiveDirectory = dirname(candidate.archivePath);
        assert.match(candidate.commit, /^[0-9a-f]{40,64}$/);
        assert.match(candidate.sha256, /^[0-9a-f]{64}$/);

        const server = await serveSourceCandidate(candidate);
        try {
            const response = await fetch(`http://127.0.0.1:${server.port}/plurnk-service.tar`);
            assert.equal(response.status, 200);
            assert.deepEqual(
                Buffer.from(await response.arrayBuffer()),
                readFileSync(candidate.archivePath),
            );
            assert.equal(
                (await fetch(`http://127.0.0.1:${server.port}/anything-else`)).status,
                404,
            );
        } finally {
            await server.close();
        }
    } finally {
        if (archiveDirectory !== undefined) {
            rmSync(archiveDirectory, { recursive: true, force: true });
        }
        rmSync(root, { recursive: true, force: true });
    }
});

test("[§config-source-candidate] dirty source is rejected rather than mislabeled", () => {
    const root = repository();
    try {
        writeFileSync(join(root, "source.txt"), "dirty\n");
        assert.throws(
            () => prepareSourceCandidate(root),
            /source candidate must be a clean Git commit/,
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
