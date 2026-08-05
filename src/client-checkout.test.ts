import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { requiredClientCheckout } from "./client-checkout.ts";

const root = resolve(import.meta.dirname, "..");

test("[§benchlet-client-checkout] client checkout paths are explicit and bench-root-relative", () => {
    for (const value of [undefined, "", "   "]) {
        assert.throws(
            () => requiredClientCheckout("/open/plurnk-bench", {
                ...(value === undefined ? {} : { CLIENT_ROOT: value }),
            }, "CLIENT_ROOT"),
            /CLIENT_ROOT must name an explicit outside-client checkout/,
        );
    }
    assert.equal(
        requiredClientCheckout("/open/plurnk-bench", { CLIENT_ROOT: " ../client " }, "CLIENT_ROOT"),
        "/open/client",
    );
    assert.equal(
        requiredClientCheckout("/open/plurnk-bench", { CLIENT_ROOT: "~/client" }, "CLIENT_ROOT"),
        resolve(homedir(), "client"),
    );
});

test("[§benchlet-client-checkout] portable defaults do not select a client checkout", () => {
    const defaults = readFileSync(resolve(root, ".env.defaults"), "utf8");
    for (const name of ["PLURNK_BENCHLET_CLIENT_ROOT", "PLURNK_BENCH_ATLAS_CLIENT_ROOT"]) {
        assert.doesNotMatch(defaults, new RegExp(`^${name}=`, "m"));
        assert.match(defaults, new RegExp(`^# ${name}=/path/to/open-client$`, "m"));
    }
});

test("[§benchlet-client-checkout] both benchlets reject a blank checkout before allocating a run", () => {
    for (const specimen of [
        {
            path: "deepswe/benchlet.ts",
            args: ["--preflight"],
            name: "PLURNK_BENCHLET_CLIENT_ROOT",
        },
        {
            path: "atlas/benchlet.ts",
            args: [],
            name: "PLURNK_BENCH_ATLAS_CLIENT_ROOT",
        },
    ]) {
        const result = spawnSync(process.execPath, [
            "--conditions=plurnk-dev",
            specimen.path,
            ...specimen.args,
        ], {
            cwd: root,
            encoding: "utf8",
            env: {
                ...process.env,
                [specimen.name]: "",
            },
        });
        assert.notEqual(result.status, 0, `${specimen.path} must reject the blank checkout`);
        assert.match(
            result.stderr,
            new RegExp(`${specimen.name} must name an explicit outside-client checkout`),
        );
        assert.doesNotMatch(result.stderr, /artifact=/, "failure precedes run allocation");
    }
});
