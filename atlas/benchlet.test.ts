import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    answerMatches,
    atlasClientArgs,
    atlasScoringCsv,
    missingAtlasTools,
    requiemIsComplete,
    successfulExecutorCalls,
    withoutMcpServers,
    writeAtlasPlugin,
} from "./benchlet.ts";

test("Atlas answer evidence requires the expected whole answer token", () => {
    assert.equal(answerMatches("Customer", "Customer"), true);
    assert.equal(answerMatches("The answer is Customer.", "Customer"), true);
    assert.equal(answerMatches("CustomerService", "Customer"), false);
});

test("Atlas scoring input preserves the pinned task, claims, prompt, and multiline answer", () => {
    const task = {
        schemaVersion: 1 as const,
        name: "scored",
        source: "source",
        prompt: "Find it.",
        enabledTools: ["filesystem_read_text_file"],
        oracle: {
            kind: "claims" as const,
            dataset: {
                name: "ScaleAI/MCP-Atlas",
                revision: "b5bcde2236c0b8772020e13dea4e481241e78677",
                taskId: "task-1",
            },
            claims: ["The answer is \"yes\".", "The value is 2."],
        },
    };
    assert.deepEqual(atlasScoringCsv(task, "Yes.\nThe value is 2."), {
        groundTruth: `${String.raw`"TASK","PROMPT","GTFA_CLAIMS"
"task-1","Find it.","[""The answer is \""yes\""."",""The value is 2.""]"`}\n`,
        model: "\"task_id\",\"response\"\n\"task-1\",\"Yes.\nThe value is 2.\"\n",
    });
});

test("Atlas runs isolate their one MCP server without discarding model credentials", () => {
    assert.deepEqual(withoutMcpServers({
        PLURNK_MCP_GITHUB: "https://example.test/mcp",
        PLURNK_MCP_GITHUB_HEADERS: "{\"Authorization\":\"secret\"}",
        PLURNK_MODEL_GROK: "xai/grok",
        XAI_API_KEY: "secret",
    }), {
        PLURNK_MODEL_GROK: "xai/grok",
        XAI_API_KEY: "secret",
    });
});

test("Atlas installs its adapter as the one server of a project plugin, run by the benchlet's own node", () => {
    const project = mkdtempSync(join(tmpdir(), "atlas-plugin-"));
    try {
        writeAtlasPlugin(project, ["server.ts", "--sandbox-url", "http://127.0.0.1:1"], "/opt/node's/bin/node");
        const root = join(project, ".agents", "plugins", "atlas");
        assert.equal(JSON.parse(readFileSync(join(root, "plugin.json"), "utf8")).name, "atlas");
        assert.deepEqual(JSON.parse(readFileSync(join(root, "mcp.json"), "utf8")).mcpServers, {
            atlas: { type: "stdio", command: "./atlas.sh", args: ["server.ts", "--sandbox-url", "http://127.0.0.1:1"] },
        });
        const wrapper = join(root, "atlas.sh");
        assert.equal(readFileSync(wrapper, "utf8"), "#!/bin/sh\nexec '/opt/node'\\''s/bin/node' \"$@\"\n");
        assert.equal(statSync(wrapper).mode & 0o111, 0o111, "the wrapper is executable");
    } finally {
        rmSync(project, { recursive: true, force: true });
    }
});

test("Atlas preflight names every task tool absent from the live fixture catalog", () => {
    assert.deepEqual(missingAtlasTools([
        { name: "filesystem_read_text_file" },
        { name: "filesystem_directory_tree" },
        null,
        { invalid: true },
    ], [
        "filesystem_read_text_file",
        "cli-mcp-server_run_command",
        "fetch_fetch",
    ]), [
        "cli-mcp-server_run_command",
        "fetch_fetch",
    ]);
});

test("Atlas candidate is rooted in the run's scratch workspace, Git-free, and retains the configured orientation survey", () => {
    assert.deepEqual(atlasClientArgs({
        filesItems: -1,
        maxTurns: 10,
        timeoutSeconds: 900,
        prompt: "task",
        projectRoot: "/runs/run1/workspace",
    }), [
        "--auto",
        "--project-root",
        "/runs/run1/workspace",
        "--no-git",
        "--files-items=-1",
        "--max-turns",
        "10",
        "--timeout",
        "900",
        "task",
    ]);
});

test("an enabled Atlas requiem is complete only with a successful call and both artifacts", () => {
    assert.equal(requiemIsComplete(0, true, true), true);
    assert.equal(requiemIsComplete(1, true, true), false);
    assert.equal(requiemIsComplete(0, false, true), false);
    assert.equal(requiemIsComplete(0, true, false), false);
});

test("Atlas evidence comes from a successful allowed tool stream, not rendered prose", () => {
    const entries = [
        {
            origin: "model",
            op: "EXEC",
            status_rx: 200,
            stream: "atlas:///1/2/3",
            target: "filesystem_read_text_file",
        },
        {
            origin: "model",
            op: "EXEC",
            status_rx: 200,
            stream: "sh:///1/2/4",
            target: "filesystem_read_text_file",
        },
        {
            origin: "model",
            op: "EXEC",
            status_rx: 400,
            stream: "atlas:///1/2/5",
            target: "filesystem_read_text_file",
        },
    ];
    assert.equal(
        successfulExecutorCalls(entries, "atlas", ["filesystem_read_text_file"]),
        1,
    );
    assert.equal(successfulExecutorCalls(entries, "atlas", ["other_tool"]), 0);
});
