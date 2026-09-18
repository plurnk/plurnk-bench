// {§benchlet-isolation} — a benchlet candidate reaches no network beyond its model: the operator's
// MCP servers and A2A agents are masked through the configuration cascade (an explicit empty
// definition outranks the operator file and masks it, plurnk-service #737), and the daemon's own
// web schemes admit no host. Search credentials are blanked for good measure. Origin: on
// 2026-09-17, four of ten deepdumb runs read the upstream solution from GitHub.

// Single-word keys that are controls, not definitions, per the services' own configuration.
const CONTROLS: Readonly<Record<"PLURNK_MCP_" | "PLURNK_A2A_", ReadonlySet<string>>> = Object.freeze({
    PLURNK_MCP_: new Set(["enabled", "expanded"]),
    PLURNK_A2A_: new Set(["enabled", "expose", "host", "port"]),
});
// A definition key is the prefix plus one server name; names never contain `_` (companions do).
const DEFINITION = /^(PLURNK_MCP_|PLURNK_A2A_)([A-Za-z][A-Za-z0-9-]*)$/;
const SEARCH_CREDENTIALS = Object.freeze(["BRAVE_API_KEY", "TAVILY_API_KEY"]);

export interface CandidateIsolation {
    readonly overrides: Readonly<Record<string, string>>;
    readonly masked: readonly string[];
}

export const candidateIsolation = (keyNames: Iterable<string>): CandidateIsolation => {
    const masked = [...new Set(keyNames)].filter((key) => {
        const definition = DEFINITION.exec(key);
        return definition !== null && !CONTROLS[definition[1] as keyof typeof CONTROLS].has(definition[2]!.toLowerCase());
    }).toSorted();
    return {
        overrides: {
            ...Object.fromEntries(masked.map((key) => [key, ""])),
            ...Object.fromEntries(SEARCH_CREDENTIALS.map((key) => [key, ""])),
            PLURNK_SCHEMES_HTTP_HOSTS: "[]",
        },
        masked,
    };
};
