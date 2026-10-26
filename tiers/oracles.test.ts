import assert from "node:assert/strict";
import test from "node:test";
import { hasAuditOutcome } from "./demo/_audit-oracle.ts";
import { observedScriptExecution, type ScriptReceipt } from "./demo/_script-oracle.ts";
import { latestStableNodeVersion, namesNodeVersion, versionsNamed } from "./demo/_web-oracle.ts";

const stream = "sh:///1/2/3/sh";
const execution = (target: string | null, body = ""): ScriptReceipt => ({
    scheme: "file",
    pathname: target,
    fragment: null,
    tx: JSON.stringify({ target: target === null ? null : { raw: target }, body }),
    rx: null,
    attrs: JSON.stringify({ stream }),
    status_rx: 200,
    origin: "model",
});
const receipt = (output = "GREETING\n", exitCode = 0, source = stream): ScriptReceipt => ({
    scheme: "sh",
    pathname: new URL(source).pathname,
    fragment: "stdout",
    tx: "{}",
    rx: JSON.stringify({ content: output, exitCode, terminal: true }),
    attrs: JSON.stringify({ streamEnd: output.length }),
    status_rx: 200,
    origin: "_plurnk",
});

test("{§demo-oracles} packet audit oracle accepts numbered findings with Markdown emphasis", () => {
    for (const answer of [
        "1. The roster is inconsistent.",
        "## 1. The roster is inconsistent.",
        "**1. The roster is inconsistent.**\n\nThe two files disagree.",
        "**1.** The roster is inconsistent.",
        "Findings:\n\n2) The dependency is missing.",
        "I did not find any material errors.",
        "No findings.",
    ]) assert.equal(hasAuditOutcome(answer), true, answer);
    for (const answer of ["", "1.", "**1.**", "I will inspect the packet.", "There are 2 files."]) {
        assert.equal(hasAuditOutcome(answer), false, answer);
    }
});

test("{§demo-oracles} script oracle accepts native script execution and shell commands with observed successful output", () => {
    for (const exec of [execution("greet.sh"), execution(null, "sh ./greet.sh"), execution(null, "chmod +x greet.sh && ./greet.sh")]) {
        assert.equal(observedScriptExecution([exec], [receipt()], "greet.sh", "GREETING"), true);
    }
});

test("{§demo-oracles} a model that verifies around the run is not failed for it", () => {
    const verified = "-rwxr-xr-x 1 u u 31 Sep 21 20:00 greet.sh\nGREETING\nexit=0\n";
    assert.equal(
        observedScriptExecution([execution(null, 'ls -l greet.sh; sh greet.sh; echo "exit=$?"')], [receipt(verified)], "greet.sh", "GREETING"),
        true,
    );
    for (const embedded of ["say GREETING\n", "GREETINGS\n", "xGREETING\n"]) {
        assert.equal(observedScriptExecution([execution("greet.sh")], [receipt(embedded)], "greet.sh", "GREETING"), false, embedded);
    }
});

test("{§demo-oracles} script oracle rejects claimed, unobserved, failed, unrelated and mismatched executions", () => {
    const cases: Array<[ScriptReceipt[], ScriptReceipt[]]> = [
        [[], []],
        [[execution("greet.sh")], []],
        [[execution("greet.sh")], [receipt("GREETING\n", 1)]],
        [[execution("greet.sh")], [receipt("WRONG\n")]],
        [[execution(null, "printf GREETING")], [receipt()]],
        [[execution("greet.sh")], [receipt("GREETING\n", 0, "sh:///1/2/4/sh")]],
        [[{ ...execution("greet.sh"), status_rx: 403 }], [receipt()]],
        [[execution("greet.sh")], [{ ...receipt(), rx: JSON.stringify({ content: "GREETING\n", exitCode: 0, terminal: false }) }]],
        [[execution("greet.sh")], [{ ...receipt(), fragment: "stderr" }]],
    ];
    for (const [execs, reads] of cases) assert.equal(observedScriptExecution(execs, reads, "greet.sh", "GREETING"), false);
});

test("{§demo-oracles} web story oracle distinguishes latest stable from a newer maintenance date or an LTS label", () => {
    assert.equal(
        latestStableNodeVersion([
            { version: "v24.99.2", lts: "Example" },
            { version: "v26.9.2", lts: false },
            { version: "v27.0.0-rc.1", lts: false },
            { version: "v26.10.1", lts: false },
            { version: "v26.10.2", lts: false },
        ]),
        "v26.10.2",
    );
    for (const malformed of [null, {}, [], [{}], [{ version: 26 }], [{ version: "v27.0.0-rc.1" }]]) {
        assert.throws(() => latestStableNodeVersion(malformed), { name: "AssertionError" });
    }
});

test("{§demo-oracles} web story oracle requires the actual version, not arbitrary digits or a partial match", () => {
    for (const answer of ["Node.js **v26.10.2** is the latest stable release.", "The latest stable is 26.10.2."]) {
        assert.equal(namesNodeVersion(answer, "v26.10.2"), true);
    }
    for (const answer of ["26", "v24.99.2 LTS", "v26.10.20", "v126.10.2", "v26.10.2-rc.1", "I searched the web."]) {
        assert.equal(namesNodeVersion(answer, "v26.10.2"), false, answer);
    }
});

test("{§demo-oracles} the retrieval oracle collects every non-prerelease version a text names", () => {
    assert.deepEqual([...versionsNamed("Node.js 26.9.0 (Current) — also v26.10.0-rc.1 and 24.11.1 LTS.")], ["v26.9.0", "v24.11.1"]);
    assert.deepEqual([...versionsNamed("I searched the web.")], []);
});
