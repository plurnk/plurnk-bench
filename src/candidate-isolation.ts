// {§benchlet-diagnostic} Disable ambient endpoint/skill aliases without destroying definitions;
// MCP and HTTP scheme switches plus the empty HTTP host allowlist prevent outbound access.
const RESOURCE = /^(PLURNK_(?:MCP|SKILLS)_[\p{Ll}\p{Lo}\p{Lm}\p{N}][\p{Ll}\p{Lo}\p{Lm}\p{N}_]*)(?:_[A-Z][A-Z0-9_]*)?$/u;
const SEARCH_CREDENTIALS = Object.freeze(["BRAVE_API_KEY"]);

export interface CandidateIsolation {
    readonly overrides: Readonly<Record<string, string>>;
    readonly masked: readonly string[];
}

export const candidateIsolation = (keyNames: Iterable<string>): CandidateIsolation => {
    const masked = [...new Set([...keyNames].flatMap((key) => {
        const resource = RESOURCE.exec(key);
        return resource === null ? [] : [resource[1]!];
    }))].toSorted();
    return {
        overrides: {
            PLURNK_MCP_ENABLED: "0",
            ...Object.fromEntries(masked.map((key) => [`${key}_ENABLED`, "0"])),
            ...Object.fromEntries(SEARCH_CREDENTIALS.map((key) => [key, ""])),
            PLURNK_SCHEMES_HTTP_ENABLED: "0",
            PLURNK_SCHEMES_HTTP_HOSTS: "[]",
        },
        masked,
    };
};
