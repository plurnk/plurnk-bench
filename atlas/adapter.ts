import {
    McpServer,
    fromJsonSchema,
    specTypeSchemas,
    type CallToolResult,
    type ServerContext,
    type Tool,
} from "@modelcontextprotocol/server";
import packageJson from "../package.json" with { type: "json" };

export interface AtlasAdapterOptions {
    readonly sandboxUrl: string;
    readonly enabledTools: readonly string[];
    readonly listTimeoutMs: number;
    readonly toolTimeoutMs: number;
    readonly fetch?: typeof fetch;
}

const positiveInteger = (value: number, label: string): number => {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return value;
};

const endpoint = (base: string, pathname: string): URL => {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/$/, "")}${pathname}`;
    url.search = "";
    url.hash = "";
    return url;
};

const responseBody = async (response: Response): Promise<string> => {
    const text = await response.text();
    return text === "" ? response.statusText : text;
};

const fetchJson = async (
    request: RequestInfo | URL,
    init: RequestInit,
    timeoutMs: number,
    fetcher: typeof fetch,
): Promise<unknown> => {
    const response = await fetcher(request, {
        ...init,
        signal: init.signal === undefined
            ? AbortSignal.timeout(timeoutMs)
            : AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) {
        throw new Error(`Atlas sandbox answered HTTP ${response.status}: ${await responseBody(response)}`);
    }
    return response.json();
};

const omitNull = <T extends Record<string, unknown>>(
    value: T,
    fields: readonly string[],
): Record<string, unknown> => Object.fromEntries(
    Object.entries(value).filter(([key, candidate]) =>
        !fields.includes(key) || candidate !== null),
);

const normalizeAtlasTool = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return candidate;
    }
    const tool = omitNull(
        candidate as Record<string, unknown>,
        ["title", "description", "outputSchema", "annotations", "icons", "_meta", "execution"],
    );
    if (
        tool.annotations !== null
        && typeof tool.annotations === "object"
        && !Array.isArray(tool.annotations)
    ) {
        tool.annotations = omitNull(
            tool.annotations as Record<string, unknown>,
            ["title", "readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"],
        );
    }
    return tool;
};

const normalizeAtlasContent = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        return candidate;
    }
    return omitNull(candidate as Record<string, unknown>, ["annotations", "_meta"]);
};

export const loadAtlasTools = async (
    options: AtlasAdapterOptions,
): Promise<Tool[]> => {
    positiveInteger(options.listTimeoutMs, "Atlas list timeout");
    const fetcher = options.fetch ?? fetch;
    const value = await fetchJson(
        endpoint(options.sandboxUrl, "/list-tools"),
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
            },
        },
        options.listTimeoutMs,
        fetcher,
    );
    if (!Array.isArray(value)) throw new Error("Atlas /list-tools response must be an array.");
    const tools = value.map((candidate, index) => {
        const parsed = specTypeSchemas.Tool.safeParse(normalizeAtlasTool(candidate));
        if (!parsed.success) {
            throw new Error(`Atlas /list-tools item ${index} is not a current MCP tool.`, {
                cause: parsed.error,
            });
        }
        return parsed.data;
    });
    const byName = new Map<string, Tool>();
    for (const tool of tools) {
        if (byName.has(tool.name)) throw new Error(`Atlas returned duplicate tool '${tool.name}'.`);
        byName.set(tool.name, tool);
    }
    const requested = new Set(options.enabledTools);
    if (requested.size !== options.enabledTools.length) {
        throw new Error("Atlas enabled tool list contains duplicates.");
    }
    const missing = [...requested].filter((name) => !byName.has(name));
    if (missing.length > 0) {
        throw new Error(`Atlas task requested unavailable tools: ${missing.join(", ")}`);
    }
    return [...requested].map((name) => byName.get(name)!);
};

const callAtlasTool = async (
    tool: string,
    args: Record<string, unknown>,
    options: AtlasAdapterOptions,
    signal: AbortSignal,
): Promise<CallToolResult> => {
    positiveInteger(options.toolTimeoutMs, "Atlas tool timeout");
    const fetcher = options.fetch ?? fetch;
    try {
        const value = await fetchJson(
            endpoint(options.sandboxUrl, "/call-tool"),
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    tool_name: tool,
                    tool_args: args,
                }),
                signal,
            },
            options.toolTimeoutMs,
            fetcher,
        );
        if (!Array.isArray(value)) throw new Error("Atlas /call-tool response must be an array.");
        return {
            content: value.map((candidate, index) => {
                const parsed = specTypeSchemas.ContentBlock.safeParse(normalizeAtlasContent(candidate));
                if (!parsed.success) {
                    throw new Error(`Atlas /call-tool content item ${index} is not current MCP content.`, {
                        cause: parsed.error,
                    });
                }
                return parsed.data;
            }),
        };
    } catch (cause) {
        return {
            content: [{
                type: "text",
                text: cause instanceof Error ? cause.message : String(cause),
            }],
            isError: true,
        };
    }
};

export const createAtlasServer = (
    tools: readonly Tool[],
    options: AtlasAdapterOptions,
): McpServer => {
    const server = new McpServer({
        name: "@plurnk/plurnk-bench/atlas",
        version: packageJson.version,
    });
    for (const tool of tools) {
        server.registerTool(
            tool.name,
            {
                ...(tool.title === undefined ? {} : { title: tool.title }),
                ...(tool.description === undefined ? {} : { description: tool.description }),
                inputSchema: fromJsonSchema(tool.inputSchema),
                ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
                ...(tool.icons === undefined ? {} : { icons: tool.icons }),
                ...(tool._meta === undefined ? {} : { _meta: tool._meta }),
            },
            async (
                args: Record<string, unknown>,
                context: ServerContext,
            ) => callAtlasTool(tool.name, args, options, context.mcpReq.signal),
        );
    }
    return server;
};
