import assert from "node:assert/strict";
import test from "node:test";
import { webMaterializationProvenance } from "./web-materialization.ts";

test("[§config-tavily-route] absent Tavily configuration records the proprietary route as unavailable", () => {
    assert.deepEqual(webMaterializationProvenance({
        XAI_API_KEY: "model-secret",
    }), {
        tavily: { configured: false, depth: "basic" },
    });
});

test("[§config-tavily-route] configured Tavily records presence and depth without the secret", () => {
    assert.deepEqual(webMaterializationProvenance({
        TAVILY_API_KEY: "paid-secret",
        PLURNK_SCHEMES_HTTP_TAVILY_DEPTH: "advanced",
    }), {
        tavily: { configured: true, depth: "advanced" },
    });
});

test("[§config-tavily-route] malformed extraction depth fails before a run", () => {
    assert.throws(
        () => webMaterializationProvenance({
            PLURNK_SCHEMES_HTTP_TAVILY_DEPTH: "automatic",
        }),
        /PLURNK_SCHEMES_HTTP_TAVILY_DEPTH must be basic or advanced/,
    );
});
