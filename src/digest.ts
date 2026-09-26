// {§digest-boundary}: the daemon's digest renders (src/publish.ts); bench only reads its digest.json.

import { closeSync, openSync, readSync } from "node:fs";
import { JSONParser } from "@streamparser/json";

// {§digest-boundary}: reporting projects the daemon's facts, never its opaque response bodies.
// Raw responses remain in the complete on-disk digest, irrespective of report size.
export const readDigest = <T = Record<string, unknown>>(path: string): T => {
    const result: Record<string, unknown> = {};
    const parser = new JSONParser({
        paths: ["$.workspaces", "$.workers", "$.loops", "$.turns", "$.provider_requests", "$.log_entries", "$.turn_attempts", "$.turn_attempts.*.response"],
        keepStack: false,
        stringBufferSize: 64 * 1024,
    });
    parser.onValue = ({ value, key, parent }) => {
        if (key === "response") {
            delete (parent as Record<string, unknown>)[key];
        } else if (typeof key === "string") {
            result[key] = value;
        }
    };
    const descriptor = openSync(path, "r");
    try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let size: number;
        while ((size = readSync(descriptor, buffer)) !== 0) parser.write(buffer.subarray(0, size));
        if (!parser.isEnded) parser.end();
    } finally { closeSync(descriptor); }
    return result as T;
};
