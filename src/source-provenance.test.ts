import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assertCleanSources, sourceProvenance } from "./source-provenance.ts";

test("(#21) untracked paths that touch no tracked directory are inert and recorded; tracked changes and untracked files inside tracked directories are dirt", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-untracked-"));
    // The host may install commit hooks globally; a fixture repository must not run them.
    const git = (...args: string[]): string => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
    try {
        git("init", "-q");
        git("config", "user.email", "bench@test");
        git("config", "user.name", "bench");
        mkdirSync(resolve(root, "pkg"));
        writeFileSync(resolve(root, "pkg", "a.txt"), "a\n");
        git("add", "pkg/a.txt");
        git("commit", "-q", "-m", "base");
        assert.deepEqual({ clean: sourceProvenance(root).clean, untracked: sourceProvenance(root).untracked }, { clean: true, untracked: [] });

        writeFileSync(resolve(root, "shot.png"), "png");
        mkdirSync(resolve(root, ".tool"));
        writeFileSync(resolve(root, ".tool", "state.json"), "{}");
        const inert = sourceProvenance(root);
        assert.equal(inert.clean, true, "a root file and a directory with no tracked content cannot reach the build");
        assert.deepEqual(inert.untracked.toSorted(), [".tool/", "shot.png"]);

        writeFileSync(resolve(root, "pkg", "b.txt"), "b\n");
        assert.equal(sourceProvenance(root).clean, false, "an untracked file inside a tracked directory is dirt");
        rmSync(resolve(root, "pkg", "b.txt"));

        writeFileSync(resolve(root, "pkg", "a.txt"), "changed\n");
        assert.equal(sourceProvenance(root).clean, false, "a tracked modification is dirt");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("[§benchlet-provenance] a dirty source is refused by name before a run; clean sources are returned for provenance", () => {
    const root = mkdtempSync(resolve(tmpdir(), "plurnk-bench-sources-"));
    const git = (...args: string[]): string => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
    try {
        git("init", "-q");
        git("config", "user.email", "bench@test");
        git("config", "user.name", "bench");
        writeFileSync(resolve(root, "plurnk.md"), "taught\n");
        git("add", "plurnk.md");
        git("commit", "-q", "-m", "base");
        assert.equal(assertCleanSources({ service: root }).service!.head, git("rev-parse", "HEAD").trim());

        writeFileSync(resolve(root, "plurnk.md"), "uncommitted teaching\n");
        assert.throws(() => assertCleanSources({ service: root }), { message: "service source is dirty; commit the exact source before a diagnostic run" });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
