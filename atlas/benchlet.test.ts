import assert from "node:assert/strict";
import test from "node:test";
import { answerMatches, atlasClientArgs, atlasScoringCsv, missingAtlasTools, requiemIsComplete, successfulExecutorCalls, withoutMcpServers, atlasEnvironment } from "./benchlet.ts";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// ─── benchlet.test.ts ───
{
test("{§benchlet-diagnostic} Atlas answer evidence requires the expected whole answer token", () => {
    assert.equal(answerMatches("Customer", "Customer"), true);
    assert.equal(answerMatches("The answer is Customer.", "Customer"), true);
    assert.equal(answerMatches("CustomerService", "Customer"), false);
});

test("{§benchlet-diagnostic} Atlas scoring input preserves the pinned task, claims, prompt, and multiline answer", () => {
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

test("{§benchlet-diagnostic} Atlas runs isolate their one MCP server without discarding model credentials", () => {
    assert.deepEqual(withoutMcpServers({
        PLURNK_MCP_github: '{"name":"github","type":"streamable-http","url":"https://example.test/mcp"}',
        PLURNK_MCP_github_ENABLED: "1",
        PLURNK_MODEL_GROK: "xai/grok",
        XAI_API_KEY: "secret",
    }), {
        PLURNK_MODEL_GROK: "xai/grok",
        XAI_API_KEY: "secret",
    });
});

test("{§benchlet-diagnostic} Atlas declares its adapter directly with the benchlet's exact node and arguments", () => {
    const args = ["server.ts", "--sandbox-url", "http://127.0.0.1:1"];
    const env = atlasEnvironment(args, "/opt/node's/bin/node");
    assert.equal(env.PLURNK_MCP_ENABLED, "1");
    assert.deepEqual(JSON.parse(env.PLURNK_MCP_atlas!), {
        name: "atlas", type: "stdio", command: "/opt/node's/bin/node", args,
    });
});

test("{§benchlet-diagnostic} Atlas preflight names every task tool absent from the live fixture catalog", () => {
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

test("{§benchlet-diagnostic} Atlas candidate is rooted in the run's scratch workspace, Git-free, and retains the configured orientation survey", () => {
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

test("{§benchlet-diagnostic} an enabled Atlas requiem is complete only with a successful call and both artifacts", () => {
    assert.equal(requiemIsComplete(0, true, true), true);
    assert.equal(requiemIsComplete(1, true, true), false);
    assert.equal(requiemIsComplete(0, false, true), false);
    assert.equal(requiemIsComplete(0, true, false), false);
});

test("{§benchlet-diagnostic} Atlas evidence comes from a successful allowed tool stream, not rendered prose", () => {
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
}

// ─── adapter.test.ts ───
{
const adapter = fileURLToPath(new URL("./server.ts", import.meta.url));
const protocolVersion = "2026-07-28";

test("{§benchlet-diagnostic} Atlas adapter exposes only task tools over strict current MCP", async (t) => {
    const calls: unknown[] = [];
    const server = createServer(async (request, response) => {
        if (request.url === "/list-tools" && request.method === "POST") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify([
                {
                    name: "filesystem_read_text_file",
                    title: null,
                    description: "Read a text file.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string" },
                        },
                        required: ["path"],
                        additionalProperties: false,
                    },
                    outputSchema: {
                        type: "object",
                        properties: {
                            content: { type: "string" },
                        },
                        required: ["content"],
                        additionalProperties: false,
                    },
                    annotations: {
                        title: null,
                        readOnlyHint: true,
                        destructiveHint: null,
                    },
                    _meta: null,
                },
                {
                    name: "filesystem_write_file",
                    description: "Write a file.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: true,
                    },
                },
            ]));
            return;
        }
        if (request.url === "/call-tool" && request.method === "POST") {
            let body = "";
            for await (const chunk of request) body += chunk;
            calls.push(JSON.parse(body));
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify([{
                type: "text",
                text: "Customer",
                annotations: null,
                _meta: null,
            }]));
            return;
        }
        response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");

    const client = new Client(
        {
            name: "atlas-adapter-test",
            version: "1.0.0",
        },
        {
            versionNegotiation: {
                mode: { pin: protocolVersion },
            },
        },
    );
    t.after(() => client.close());
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [
                adapter,
                "--sandbox-url",
                `http://127.0.0.1:${address.port}`,
                "--enabled-tools",
                JSON.stringify(["filesystem_read_text_file"]),
                "--list-timeout-ms",
                "30000",
                "--tool-timeout-ms",
                "30000",
            ],
        }),
    );

    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), protocolVersion);
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((tool) => tool.name), ["filesystem_read_text_file"]);
    assert.equal(tools[0]?.outputSchema, undefined);
    assert.equal(tools[0]?.annotations?.readOnlyHint, true);
    const result = await client.callTool({
        name: "filesystem_read_text_file",
        arguments: {
            path: "/data/Barber Shop.csv",
        },
    });
    assert.deepEqual(result.content, [{
        type: "text",
        text: "Customer",
    }]);
    assert.deepEqual(calls, [{
        tool_name: "filesystem_read_text_file",
        tool_args: {
            path: "/data/Barber Shop.csv",
        },
    }]);
});

test("{§benchlet-diagnostic} Atlas adapter fails before serving when a task tool is unavailable", async () => {
    const { loadAtlasTools } = await import("./adapter.ts");
    await assert.rejects(
        loadAtlasTools({
            sandboxUrl: "https://atlas.invalid",
            enabledTools: ["missing"],
            listTimeoutMs: 30000,
            toolTimeoutMs: 30000,
            fetch: async () => new Response(JSON.stringify([{
                name: "available",
                inputSchema: {
                    type: "object",
                },
            }]), {
                status: 200,
                headers: {
                    "content-type": "application/json",
                },
            }),
        }),
        /requested unavailable tools: missing/,
    );
});
}
