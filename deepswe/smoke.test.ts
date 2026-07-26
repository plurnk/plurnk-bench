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

test("[§config-browser-disabled] smoke disables unavailable Playwright runtime", () => {
    assert.match(smoke, /flags\+=\(--agent-env "PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD=disabled"\)/);
});
