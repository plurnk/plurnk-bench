// {§benchlet-isolation} — a benchlet candidate reaches no network beyond its model: the operator's
// MCP servers and A2A agents are masked through the configuration cascade (an explicit empty
// definition outranks the operator file and masks it, plurnk-service #737); the `web` trait is
// denied at the service capability ceiling ({§capability-admission}: the one resolver that refuses
// the operation also drops the scheme's reference and its survey row, so the model is never taught
// a door it may not open, plurnk-bench #38); the masked families themselves are denied by name, so
// neither stands in the survey empty (plurnk-service #842); and the http package's host policy admits no host, the
// daemon's own network boundary, a different choice from the model's capability. Search
// credentials are blanked for good measure. Origin: on 2026-09-17, four of ten deepdumb runs read
// the upstream solution from GitHub.

// Single-word keys that are controls, not definitions, per the services' own configuration.
const CONTROLS: Readonly<Record<"PLURNK_MCP_" | "PLURNK_A2A_", ReadonlySet<string>>> = Object.freeze({
    PLURNK_MCP_: new Set(["enabled", "expanded"]),
    PLURNK_A2A_: new Set(["enabled", "expose", "host", "port"]),
});
// A definition key is the prefix plus one server name; names never contain `_` (companions do).
const DEFINITION = /^(PLURNK_MCP_|PLURNK_A2A_)([A-Za-z][A-Za-z0-9-]*)$/;
const SEARCH_CREDENTIALS = Object.freeze(["BRAVE_API_KEY", "TAVILY_API_KEY"]);
const CAPABILITIES = Object.freeze({ deny: Object.freeze([
    Object.freeze({ traits: Object.freeze(["web"]) }),
    Object.freeze({ operation: "mcp" }),
    Object.freeze({ operation: "a2a" }),
]) });

export interface CandidateIsolation {
    readonly overrides: Readonly<Record<string, string>>;
    readonly masked: readonly string[];
    readonly capabilities: typeof CAPABILITIES;
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
            PLURNK_SERVICE_CAPABILITIES: JSON.stringify(CAPABILITIES),
            PLURNK_SCHEMES_HTTP_HOSTS: "[]",
        },
        masked,
        capabilities: CAPABILITIES,
    };
};
