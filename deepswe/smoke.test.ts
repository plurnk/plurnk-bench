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

test("[§config-embedding-route] every mode forwards the public embedding route and allowlists its host; the operator's embedding config never rides", () => {
    const defaults = readFileSync(new URL("../.env.defaults", import.meta.url), "utf8");
    assert.match(defaults, /^PLURNK_BENCH_EMBEDDING_ROUTE=plurnk-embed\/sentence-transformers\/all-MiniLM-L6-v2$/m);
    assert.match(defaults, /^PLURNK_BENCH_EMBEDDING_BASE_URL=https:\/\/embed\.plurnk\.ai\/v1$/m);
    assert.match(smoke, /PLURNK_EMBEDDING_\*\) continue;;/);
    assert.match(smoke, /--agent-env "PLURNK_EMBEDDING_MODEL=\$PLURNK_BENCH_EMBEDDING_ROUTE"/);
    assert.match(smoke, /--agent-env "PLURNK_PROVIDERS_PROVIDER_\$\{EMBED_PREFIX\}_NPM=@ai-sdk\/openai-compatible"/);
    assert.match(smoke, /--agent-env "PLURNK_PROVIDERS_PROVIDER_\$\{EMBED_PREFIX\}_BASE_URL=\$PLURNK_BENCH_EMBEDDING_BASE_URL"/);
    assert.match(smoke, /EGRESS_DOMAINS="\$\{EGRESS_DOMAINS:\+\$EGRESS_DOMAINS,\}\$EMBED_HOST"/);
    // The route rides outside the mode branches: the corpus and a single diagnostic alike.
    assert.ok(smoke.indexOf("PLURNK_EMBEDDING_MODEL=$PLURNK_BENCH_EMBEDDING_ROUTE") > smoke.lastIndexOf("\nfi\n"));
});

test("[§config-resource-samples] every run samples docker stats once a minute into the job directory until pier exits", () => {
    assert.match(smoke, /while kill -0 "\$PIER_PID" 2>\/dev\/null; do/);
    assert.match(smoke, /docker stats --no-stream --format '\{\{json \.\}\}'/);
    assert.match(smoke, /"\$JOB\/docker-stats\.jsonl"/);
    assert.match(smoke, /sleep 60/);
});

test("[§config-image-prepull] every task image is pulled outside the run, with retries and a disk floor, before any trial starts", () => {
    const prepull = readFileSync(new URL("./prepull.sh", import.meta.url), "utf8");
    assert.match(smoke, /\ndeepswe\/prepull\.sh "\$TASK"\n/);
    assert.ok(smoke.indexOf('deepswe/prepull.sh "$TASK"') < smoke.indexOf("pier run -p"), "images are local before pier starts");
    assert.match(prepull, /docker_image \*= \*"/);
    assert.match(prepull, /xargs -P "\$JOBS"/);
    assert.match(prepull, /for attempt in \$\(seq 1 "\$ATTEMPTS"\)/);
    assert.match(prepull, /FLOOR_GB/);
    assert.match(prepull, /unresolved images — a run must not start trials without them/);
});

test("[§config-digest-preflight] the bench's installed service must equal the version the corpus installs", () => {
    assert.match(smoke, /DIGEST_VERSION="\$\(node -e 'console\.log\(require\("@plurnk\/plurnk-service\/package\.json"\)\.version\)'\)"/);
    assert.match(smoke, /\[ "\$DIGEST_VERSION" = "\$SERVICE_VERSION" \] \|\| \{/);
});

test("[§config-publisher-decoupled][§config-failed-setup-report] the publisher never owns pier's lifetime; a final pass publishes the rest; failed setups are listed", () => {
    assert.match(smoke, /trap 'kill "\$PIER_PID" \$PUB_PID 2>\/dev\/null \|\| true' EXIT INT TERM/);
    assert.match(smoke, /node src\/publish\.ts --watch "\$JOB" --pid "\$PIER_PID" \\\n\s+\|\| echo/);
    assert.match(smoke, /\) &\nPUB_PID=\$!/);
    assert.match(smoke, /wait "\$PIER_PID" \|\| pier_status=\$\?/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=deepswe node src\/publish\.ts "\$JOB"\n/);
    assert.match(smoke, /failed-setup\.txt/);
});

test("[§results-canon][§publish-live] job scratch lives under the benchmarks home and every trial publishes as it lands", () => {
    assert.match(smoke, /JOBS_ROOT="\$\(node src\/publish\.ts --jobs deepswe\)"/);
    assert.match(smoke, /"\$\{select_flags\[@\]\}" -o "\$JOBS_ROOT" --env docker &/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=deepswe node src\/publish\.ts --watch "\$JOB" --pid "\$PIER_PID"/);
    assert.doesNotMatch(smoke, /ls -dt jobs\//);
});

test("[§config-model-default] the runner uses the ordinary PLURNK_MODEL cascade", () => {
    assert.match(smoke, /source_env_file "\$OPERATOR_ENV"\nsource_env_file "\.env\.defaults"/);
    assert.match(smoke, /MODEL="\$PLURNK_MODEL"/);
    assert.doesNotMatch(smoke, /PLURNK_BENCH_MODEL|\$\{2:/);
});
