import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./smoke.sh", import.meta.url), "utf8");

test("[§config-package-version] smoke pins resolved service and client publications", () => {
    assert.match(smoke, /npm view @plurnk\/plurnk-service version/);
    assert.match(smoke, /npm view @plurnk\/plurnk version/);
    assert.match(smoke, /--agent-kwarg "service_version=\$SERVICE_VERSION"/);
    assert.match(smoke, /--agent-kwarg "client_version=\$CLIENT_VERSION"/);
    assert.doesNotMatch(smoke, /after a @plurnk version bump/);
});

test("[§config-tavily-route] smoke carries configured Tavily like other optional web providers and records the route", () => {
    assert.doesNotMatch(smoke, /PLAYWRIGHT/);
    assert.match(smoke, /_BASE_URL\$\|_API_KEY\$/);
    assert.doesNotMatch(smoke, /TAVILY_API_KEY\|PLURNK_SCHEMES_HTTP_TAVILY_DEPTH\) continue/);
    assert.match(smoke, /TAVILY_CONFIGURED/);
    assert.match(smoke, /--agent-kwarg "tavily_configured=\$TAVILY_CONFIGURED"/);
    assert.match(smoke, /--agent-kwarg "tavily_depth=\$TAVILY_DEPTH"/);
});
