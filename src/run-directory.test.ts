import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import test from "node:test";
import { allocateRunDirectory } from "./run-directory.ts";

test("numbered forensic runs share one flat, collision-safe namespace", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-bench-runs-"));
    try {
        mkdirSync(resolve(root, "run4-existing"));
        assert.equal(
            basename(allocateRunDirectory(root, ["atlas", "filesystem read", "grok"])),
            "run5-atlas-filesystem-read-grok",
        );
        assert.equal(
            basename(allocateRunDirectory(root, ["deepswe", "abs", "glm"])),
            "run6-deepswe-abs-glm",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
