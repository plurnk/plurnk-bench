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

test("[§config-egress] smoke derives the allowlist from the run's aliases and forwards it to the driver", () => {
    assert.match(smoke, /providers\.json/);
    assert.match(smoke, /--agent-kwarg "egress_domains=\$EGRESS_DOMAINS"/);
    assert.match(smoke, /api\.tavily\.com/);
});

test("[§config-carry] the MCP fleet never rides into the container", () => {
    assert.match(smoke, /PLURNK_MCP_\*\) continue;;/);
});

test("[§config-carry] `all` mode runs the corpus web-free on the minimal manifest", () => {
    assert.match(smoke, /\[ "\$TASK" = all \] && TAVILY_API_KEY=""/);
    assert.match(smoke, /\[ "\$TASK" = all \] && select_flags=\(--n-concurrent/);
    assert.doesNotMatch(smoke, /\[ "\$TASK" = all \] && exit 0/);
});

test("[§results-canon][§publish-live] job scratch lives under the benchmarks home and every trial publishes as it lands", () => {
    assert.match(smoke, /JOBS_ROOT="\$\(node src\/publish\.ts --jobs deepswe\)"/);
    assert.match(smoke, /"\$\{select_flags\[@\]\}" -o "\$JOBS_ROOT" --env docker &/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=deepswe node src\/publish\.ts --watch "\$JOB" --pid "\$PIER_PID"/);
    assert.doesNotMatch(smoke, /ls -dt jobs\//);
});

test("[§config-model-default] the runner's model is explicit, else PLURNK_BENCH_MODEL, else rtx5070", () => {
    assert.match(smoke, /MODEL="\$\{2:-\$\{PLURNK_BENCH_MODEL:-rtx5070\}\}"/);
    assert.doesNotMatch(smoke, /PLURNK_MODEL:\?set PLURNK_MODEL/);
});
