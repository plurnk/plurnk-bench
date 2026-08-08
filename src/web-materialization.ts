export type TavilyDepth = "basic" | "advanced";

export interface WebMaterializationProvenance {
    tavily: {
        configured: boolean;
        depth: TavilyDepth;
    };
}

export const webMaterializationProvenance = (
    environment: Readonly<NodeJS.ProcessEnv>,
): WebMaterializationProvenance => {
    const depth = environment.PLURNK_SCHEMES_HTTP_TAVILY_DEPTH?.trim() || "basic";
    if (depth !== "basic" && depth !== "advanced") {
        throw new Error("PLURNK_SCHEMES_HTTP_TAVILY_DEPTH must be basic or advanced");
    }

    return {
        tavily: {
            configured: (environment.TAVILY_API_KEY?.trim() ?? "") !== "",
            depth,
        },
    };
};
