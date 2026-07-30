import { parseArgs } from "node:util";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
    createAtlasServer,
    loadAtlasTools,
    type AtlasAdapterOptions,
} from "./adapter.ts";

const positiveInteger = (value: string | undefined, label: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
};

const parseEnabledTools = (value: string | undefined): string[] => {
    if (value === undefined) throw new Error("--enabled-tools is required.");
    const parsed: unknown = JSON.parse(value);
    if (
        !Array.isArray(parsed)
        || parsed.some((candidate) => typeof candidate !== "string" || candidate === "")
    ) {
        throw new Error("--enabled-tools must be a JSON array of non-empty tool names.");
    }
    return parsed;
};

const { values } = parseArgs({
    options: {
        "sandbox-url": {
            type: "string",
        },
        "enabled-tools": {
            type: "string",
        },
        "list-timeout-ms": {
            type: "string",
        },
        "tool-timeout-ms": {
            type: "string",
        },
    },
    strict: true,
});

if (values["sandbox-url"] === undefined) throw new Error("--sandbox-url is required.");

const options: AtlasAdapterOptions = {
    sandboxUrl: values["sandbox-url"],
    enabledTools: parseEnabledTools(values["enabled-tools"]),
    listTimeoutMs: positiveInteger(values["list-timeout-ms"], "--list-timeout-ms"),
    toolTimeoutMs: positiveInteger(values["tool-timeout-ms"], "--tool-timeout-ms"),
};
const tools = await loadAtlasTools(options);

serveStdio(
    () => createAtlasServer(tools, options),
    {
        legacy: "reject",
        onerror: (error) => {
            console.error(error);
        },
    },
);
