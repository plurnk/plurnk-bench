import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const smoke = readFileSync(new URL("./smoke.sh", import.meta.url), "utf8");

test("[§enterprise-provenance] the runner pins the exact upstream corpus and refuses drift", () => {
    assert.match(smoke, /BENCH_COMMIT="5a79ad04237d786414be0473da79fb1754574aff"/);
    assert.match(smoke, /git -C "\$BENCH_ROOT" checkout --quiet --detach "\$BENCH_COMMIT"/);
    assert.match(smoke, /rev-parse HEAD\)" = "\$BENCH_COMMIT" \]/);
    assert.match(smoke, /status --porcelain --untracked-files=no/);
});

test("[§enterprise-profiles] profiles expand to the benchmark's trial counts", () => {
    assert.match(smoke, /single\) TRIALS=1;;/);
    assert.match(smoke, /comparison\) TRIALS=3;;/);
    assert.match(smoke, /canonical\) TRIALS=10;;/);
    assert.match(smoke, /-k "\$TRIALS" -n "\$JOBS"/);
});

test("[§enterprise-oracle] a missing judge key refuses before any spend", () => {
    assert.match(smoke, /\[ -n "\$\{OPENAI_API_KEY:-\}" \] \|\| \{ echo "enterprise: OPENAI_API_KEY is absent/);
    assert.doesNotMatch(smoke, /--agent-env "OPENAI_API_KEY/);
});

test("[§enterprise-mcp-carry] the benchmark's mcp.json rides to the driver; the operator's fleet never does", () => {
    assert.match(smoke, /--mcp-config "\$BENCH_ROOT\/mcp\.json"/);
    assert.match(smoke, /--ak "mcp_host=\$MCP_HOST"/);
    assert.match(smoke, /MCP_HOST="\$\(hostname -I/);
    assert.doesNotMatch(smoke, /PLURNK_MCP_/);
});

test("[§config-package-version] the runner pins resolved service and client publications", () => {
    assert.match(smoke, /npm view @plurnk\/plurnk-service version/);
    assert.match(smoke, /npm view @plurnk\/plurnk version/);
    assert.match(smoke, /--ak "service_version=\$SERVICE_VERSION"/);
    assert.match(smoke, /--ak "client_version=\$CLIENT_VERSION"/);
});

test("[§config-carry] the minimal manifest carries the alias layer and its credentials only", () => {
    assert.match(smoke, /providers\.json/);
    assert.match(smoke, /flags=\(--agent-env "PLURNK_MODEL=\$MODEL"\)/);
    assert.doesNotMatch(smoke, /_BASE_URL\$\|_API_KEY\$/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=enterprise node src\/publish\.ts/);
});

test("[§config-budget] the client timeout tracks each task's own [agent] budget minus headroom", () => {
    assert.match(smoke, /HEADROOM_SEC=30/);
    assert.match(smoke, /s=="\[agent\]" && \$1 ~ \/timeout_sec\//);
    assert.match(smoke, /RUN_TIMEOUTS\+=\("\$\{PLURNK_BENCH_TIMEOUT_SEC:-\$\(\( group - HEADROOM_SEC \)\)\}"\)/);
    assert.match(smoke, /--ak "client_timeout_sec=\$\{RUN_TIMEOUTS\[\$i\]\}"/);
    assert.doesNotMatch(smoke, /refusing one global client timeout/);
});

test("[§enterprise-budget-groups] the corpus runs as one Harbor job per budget group, each followed live", () => {
    assert.match(smoke, /GROUPS_ROOT="\.cache\/enterprise-groups"/);
    assert.match(smoke, /cp -a "\$dir" "\$GROUPS_ROOT\/\$budget\/"/);
    assert.match(smoke, /for i in "\$\{!RUN_PATHS\[@\]\}"; do/);
    assert.match(smoke, /-k "\$TRIALS" -n "\$JOBS" -o "\$JOBS_ROOT" --yes &/);
    assert.match(smoke, /wait "\$HARBOR_PID" \|\|/);
});

test("[§results-canon][§publish-live] job scratch lives under the benchmarks home and every trial publishes as it lands", () => {
    assert.match(smoke, /JOBS_ROOT="\$\(node src\/publish\.ts --jobs enterprise\)"/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=enterprise node src\/publish\.ts --watch "\$JOB" --pid "\$HARBOR_PID"/);
    assert.doesNotMatch(smoke, /-o jobs\b|ls -dt jobs\//);
});

test("[§config-model-default] the runner uses the ordinary PLURNK_MODEL cascade", () => {
    assert.match(smoke, /source_env_file "\$OPERATOR_ENV"\nsource_env_file "\.env\.defaults"/);
    assert.match(smoke, /MODEL="\$PLURNK_MODEL"/);
    assert.doesNotMatch(smoke, /PLURNK_BENCH_MODEL|\$\{2:/);
});
