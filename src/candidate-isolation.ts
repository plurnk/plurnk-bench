// {§benchlet-isolation} Disable ambient endpoint/skill aliases without destroying definitions;
// capability and HTTP ceilings independently prevent model-created outbound access.
const RESOURCE = /^(PLURNK_(?:MCP|A2A|SKILLS)_[\p{Ll}\p{Lo}\p{Lm}\p{N}][\p{Ll}\p{Lo}\p{Lm}\p{N}_]*)(?:_[A-Z][A-Z0-9_]*)?$/u;
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
    const masked = [...new Set([...keyNames].flatMap((key) => {
        const resource = RESOURCE.exec(key);
        return resource === null ? [] : [resource[1]!];
    }))].toSorted();
    return {
        overrides: {
            PLURNK_MCP_ENABLED: "0",
            PLURNK_A2A_ENABLED: "0",
            ...Object.fromEntries(masked.map((key) => [`${key}_ENABLED`, "0"])),
            ...Object.fromEntries(SEARCH_CREDENTIALS.map((key) => [key, ""])),
            PLURNK_SERVICE_CAPABILITIES: JSON.stringify(CAPABILITIES),
            PLURNK_SCHEMES_HTTP_HOSTS: "[]",
        },
        masked,
        capabilities: CAPABILITIES,
    };
};
