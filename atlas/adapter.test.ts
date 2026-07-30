import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const adapter = fileURLToPath(new URL("./server.ts", import.meta.url));
const protocolVersion = "2026-07-28";

test("Atlas adapter exposes only task tools over strict current MCP", async (t) => {
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

test("Atlas adapter fails before serving when a task tool is unavailable", async () => {
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
