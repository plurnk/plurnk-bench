import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("{§bench-relock} a fresh client builds against the selected packed contracts without changing source or lockfiles", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-candidate-contracts-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const service = join(root, "service");
    const contracts = join(service, "plurnk-contracts");
    const client = join(root, "client");
    await Promise.all([mkdir(contracts, { recursive: true }), mkdir(join(service, "scripts"), { recursive: true }), mkdir(client)]);
    const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
    await json(join(service, "package.json"), { private: true, workspaces: ["plurnk-contracts"] });
    await json(join(contracts, "package.json"), { name: "@plurnk/plurnk-contracts", version: "1.0.0", type: "module", exports: "./index.js" });
    await writeFile(join(contracts, "index.js"), 'export const candidateContract = "selected revision";\n');
    await writeFile(join(service, "scripts/package-projection.mjs"), "export async function projectTarball() {}\n");
    const manifest = { private: true, type: "module", scripts: { build: "node build.mjs" }, dependencies: { "@plurnk/plurnk-contracts": "^1.0.0" } };
    await json(join(client, "package.json"), manifest);
    await json(join(client, "package-lock.json"), { name: "fixture", lockfileVersion: 3, packages: {} });
    await writeFile(join(client, "build.mjs"), 'import { candidateContract } from "@plurnk/plurnk-contracts"; import { writeFileSync } from "node:fs"; writeFileSync("built.txt", candidateContract);\n');
    const sources = await Promise.all(["package.json", "package-lock.json"].map((name) => readFile(join(client, name), "utf8")));
    await assert.rejects(execute("npm", ["run", "build"], { cwd: client }), /ERR_MODULE_NOT_FOUND/);
    await execute(process.execPath, [join(import.meta.dirname, "candidate-client.ts"), service, client]);
    assert.equal(await readFile(join(client, "built.txt"), "utf8"), "selected revision");
    assert.deepEqual(await Promise.all(["package.json", "package-lock.json"].map((name) => readFile(join(client, name), "utf8"))), sources);
});
