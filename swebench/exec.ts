// SPEC §swebench. Executor forwarding for the candidate container: the daemon spawns
// every executor by name through PATH, so a shim directory in front of the candidate's
// PATH forwards each one into the long-lived task container when the command's cwd is
// inside the candidate repository, mounted there at its own host path so cwd and every
// path in output line up; commands from anywhere else (the client build, the daemon's
// own tooling) run on the host through the saved real PATH.
//
// Divergence from deepswe's shims: the SWE-bench eval image activates its conda `testbed`
// environment only in a LOGIN shell (its own eval script sources conda explicitly). The
// forwarded command therefore runs through `bash -lc`, so the image's toolchain is the
// candidate's exactly as it is the verifier's; a non-login `docker exec` would resolve the
// base interpreter and hand the model an environment the oracle never uses.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const EXECUTOR_SHIMS: readonly string[] = Object.freeze([
    "sh", "bash", "node", "python3", "python", "pip", "pip3", "pytest", "perl", "ruby", "lua", "deno", "bun", "tclsh", "bc", "awk",
    "jq", "sqlite3", "npm", "npx", "pnpm", "yarn", "cargo", "rustc", "go", "make",
]);

export interface ContainerExec {
    readonly container: string;
    readonly repository: string;
    readonly user: string;
    readonly home: string;
    readonly realPath: string;
}

// Every value is a literal: the daemon scrubs its own PLURNK_* variables from subprocess
// environments, so nothing but PATH is relied upon to reach the command.
const shq = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

// `bash -lc 'exec "$0" "$@"' NAME ...args` runs NAME in the image's login shell (conda
// active) while passing the caller's arguments through untouched.
export const executorShim = (name: string, exec: ContainerExec): string => [
    "#!/bin/sh",
    "# SPEC §swebench — inside the candidate repository the command runs in the task container",
    "# at the same path, in the image's login shell; anywhere else it runs on the host.",
    'case "${PWD}/" in',
    "    " + shq(exec.repository + "/") + '*) exec docker exec -i -u ' + shq(exec.user) + ' -w "${PWD}" -e HOME=' + shq(exec.home) + " -e LANG=C.UTF-8 -e LC_ALL=C.UTF-8 " + shq(exec.container) + " bash -lc 'exec \"$0\" \"$@\"' " + shq(name) + ' "$@" ;;',
    "esac",
    "PATH=" + shq(exec.realPath) + " exec " + shq(name) + ' "$@"',
    "",
].join("\n");

export const writeExecutorShims = (binDir: string, exec: ContainerExec): void => {
    mkdirSync(binDir, { recursive: true });
    for (const name of EXECUTOR_SHIMS) writeFileSync(resolve(binDir, name), executorShim(name, exec), { mode: 0o755 });
};
