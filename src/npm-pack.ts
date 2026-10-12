// {§bench-relock} npm 11 answers `pack --json` with an array of records; npm 12 keys the records by
// package name. Every bench consumer of that envelope reads it through here.
export interface PackRecord { readonly name: string; readonly version: string; readonly filename: string }

export function packRecords(source: string): PackRecord[] {
    const value: unknown = JSON.parse(source);
    const records: unknown[] = Array.isArray(value) ? value : value !== null && typeof value === "object" ? Object.values(value) : [];
    if (records.length === 0) throw new Error("npm pack returned no artifacts");
    return records.map((record) => {
        const { name, version, filename } = (record ?? {}) as Partial<Record<keyof PackRecord, unknown>>;
        if (typeof name !== "string" || typeof version !== "string" || typeof filename !== "string" || filename.length === 0) {
            throw new Error("npm pack returned an artifact without a name, version or filename");
        }
        return { name, version, filename };
    });
}

// The candidate client consumes exactly the platform's contracts package.
export function packedContracts(source: string): PackRecord {
    let records: PackRecord[];
    try { records = packRecords(source); } catch (error) { throw new Error("Candidate platform did not pack its contracts", { cause: error }); }
    if (records.length !== 1 || records[0]!.name !== "@plurnk/plurnk-contracts") throw new Error("Candidate platform did not pack its contracts");
    return records[0]!;
}
