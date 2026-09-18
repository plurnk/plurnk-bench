import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXECUTOR_SHIMS, executorShim, writeExecutorShims } from "./exec.ts";

const exec = { container: "c0ffee", repository: "/runs/run1/repo", user: "1000:1000", home: "/root", realPath: "/usr/bin:/bin" };

test("[§swebench-container-exec] a shim forwards inside the repository through the image's login shell and runs the real binary anywhere else", () => {
    const shim = executorShim("python", exec);
    assert.match(shim, /^#!\/bin\/sh\n/);
    assert.ok(shim.includes("    '/runs/run1/repo/'*"), "the repository prefix is the forward rule");
    assert.ok(
        shim.includes("exec docker exec -i -u '1000:1000' -w \"${PWD}\" -e HOME='/root' 'c0ffee' bash -lc 'exec \"$0\" \"$@\"' 'python' \"$@\""),
        "the container command runs in a login shell with the caller's arguments intact",
    );
    assert.ok(shim.includes("PATH='/usr/bin:/bin' exec 'python' \"$@\""), "outside the repository the real binary runs on the host");
});

test("[§swebench-container-exec] writing shims creates one executable per executor name", () => {
    const dir = mkdtempSync(join(tmpdir(), "swebench-exec-"));
    writeExecutorShims(dir, exec);
    for (const name of EXECUTOR_SHIMS) {
        const path = join(dir, name);
        assert.equal(statSync(path).mode & 0o777, 0o755, `${name} is executable`);
        assert.ok(readFileSync(path, "utf8").includes("docker exec"), `${name} forwards`);
    }
    // The image's interpreters are forwarded; `git` is deliberately absent — the daemon reads
    // membership with its own git on the host, where the repository lives (deepswe's list too).
    assert.ok(EXECUTOR_SHIMS.includes("python") && EXECUTOR_SHIMS.includes("pytest"), "the image's interpreters are forwarded");
    assert.ok(!EXECUTOR_SHIMS.includes("git"), "the daemon's git stays host-side");
});
