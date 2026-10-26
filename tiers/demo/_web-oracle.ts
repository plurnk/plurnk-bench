import assert from "node:assert/strict";

export const latestStableNodeVersion = (index: unknown): string => {
    assert.ok(Array.isArray(index), "the Node release oracle requires the official release index array");
    const versions = index.flatMap((release: unknown) => {
        assert.ok(release !== null && typeof release === "object" && "version" in release
            && typeof release.version === "string", "each Node release has a version string");
        const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(release.version);
        return match === null ? [] : [{ version: release.version, parts: match.slice(1).map(Number) }];
    }).toSorted((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
    assert.ok(versions[0], "the Node release index contains a stable version");
    return versions[0].version;
};

// Every well-formed non-prerelease version a text names, as `vMAJOR.MINOR.PATCH`.
export const versionsNamed = (text: string): Set<string> =>
    new Set([...text.matchAll(/\bv?(\d+\.\d+\.\d+)(?!-)/gi)].map((match) => `v${match[1]}`));

export const namesNodeVersion = (answer: string, version: string): boolean =>
    [...answer.matchAll(/\bv?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/gi)]
        .some((match) => `v${match[1]}` === version);
