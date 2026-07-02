// Per-trial forensic artifact — REUSE the daemon's own digest (plurnk-service#264/#303),
// never rebuild it. Bench hands digest the pointer (dbPath) + optional run scope from the
// record's handle and reads no DB itself; digest owns the DB→waterfall projection.

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
    const { dbPath, runId, sessionId } = record.run;
    const digestDir = digestDirFor(dbPath);
    Digest.run({
        dbPath,
        digestDir,
        ...(runId !== undefined ? { runId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
    });
    return digestDir;
};
