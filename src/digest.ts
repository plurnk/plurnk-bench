// Per-trial forensic artifact (SPEC §digest-boundary) — REUSE the daemon's own digest (plurnk-service#264/#303),
// never rebuild it. Bench hands digest the pointer (dbPath) + optional run scope from the
// record's handle and reads no DB itself; digest owns the DB→waterfall projection.

import { closeSync, openSync, readSync } from "node:fs";
import { JSONParser } from "@streamparser/json";
import Digest from "@plurnk/plurnk-service/digest";
import { dirname, join } from "node:path";
import type { BenchRecord } from "./record.ts";

// The digest artifact lives beside the trial's `agent/` dir:
// <trial>/agent/plurnk.db → <trial>/digest. `join` normalizes the `..`, preserving
// whether the input path was relative or absolute.
export const digestDirFor = (dbPath: string): string => join(dirname(dbPath), "..", "digest");

// Render a record's daemon DB into <trial>/digest. Scopes to one run when the loop doc
// supplied the coordinate; otherwise digest renders the whole DB from dbPath alone. No
// run handle (no DB copied) → nothing to render. Digest.run throws on a missing/corrupt
// DB — a real signal, surfaced, not swallowed.
export const renderDigest = (record: BenchRecord): string | null => {
    if (record.run === undefined) return null;
    const { dbPath, workerId, workspaceId } = record.run;
    const digestDir = digestDirFor(dbPath);
    Digest.run({
        dbPath,
        digestDir,
        ...(workerId !== undefined ? { workerId } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
    });
    return digestDir;
};

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
