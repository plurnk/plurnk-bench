import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ─── smoke.test.ts ───
{
const smoke = readFileSync(new URL("./smoke.sh", import.meta.url), "utf8");

test("{§enterprise} the runner pins the exact upstream corpus and refuses drift", () => {
    assert.match(smoke, /BENCH_COMMIT="5a79ad04237d786414be0473da79fb1754574aff"/);
    assert.match(smoke, /git -C "\$BENCH_ROOT" checkout --quiet --detach "\$BENCH_COMMIT"/);
    assert.match(smoke, /rev-parse HEAD\)" = "\$BENCH_COMMIT" \]/);
    assert.match(smoke, /status --porcelain --untracked-files=no/);
});

test("{§enterprise} profiles expand to the benchmark's trial counts", () => {
    assert.match(smoke, /single\) TRIALS=1;;/);
    assert.match(smoke, /comparison\) TRIALS=3;;/);
    assert.match(smoke, /canonical\) TRIALS=10;;/);
    assert.match(smoke, /-k "\$TRIALS" -n "\$JOBS"/);
});

test("{§enterprise} a missing judge key refuses before any spend", () => {
    assert.match(smoke, /\[ -n "\$\{OPENAI_API_KEY:-\}" \] \|\| \{ echo "enterprise: OPENAI_API_KEY is absent/);
    assert.doesNotMatch(smoke, /--agent-env "OPENAI_API_KEY/);
});

test("{§enterprise} the benchmark's mcp.json rides to the driver; the operator's fleet never does", () => {
    assert.match(smoke, /--mcp-config "\$BENCH_ROOT\/mcp\.json"/);
    assert.match(smoke, /--ak "mcp_host=\$MCP_HOST"/);
    assert.match(smoke, /MCP_HOST="\$\(hostname -I/);
    assert.doesNotMatch(smoke, /PLURNK_MCP_/);
});

test("{§config-carry} the runner pins resolved service and client publications", () => {
    assert.match(smoke, /npm view @plurnk\/plurnk-service version/);
    assert.match(smoke, /npm view @plurnk\/plurnk version/);
    assert.match(smoke, /--ak "service_version=\$SERVICE_VERSION"/);
    assert.match(smoke, /--ak "client_version=\$CLIENT_VERSION"/);
});

test("{§config-carry} the minimal manifest carries the alias layer and its credentials only", () => {
    assert.match(smoke, /providers\.json/);
    assert.match(smoke, /flags=\(--agent-env "PLURNK_MODEL=\$MODEL"\)/);
    // Server approval is benchmark configuration, not a per-message grant.
    assert.match(smoke, /flags\+=\(--agent-env "PLURNK_SERVICE_PROPOSALS=\$PLURNK_SERVICE_PROPOSALS"\)/);
    assert.doesNotMatch(smoke, /_BASE_URL\$\|_API_KEY\$/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=enterprise node src\/publish\.ts/);
});

test("{§config-carry} the client timeout tracks each task's own [agent] budget minus headroom", () => {
    assert.match(smoke, /HEADROOM_SEC=30/);
    assert.match(smoke, /s=="\[agent\]" && \$1 ~ \/timeout_sec\//);
    assert.match(smoke, /RUN_TIMEOUTS\+=\("\$\{PLURNK_BENCH_TIMEOUT_SEC:-\$\(\( group - HEADROOM_SEC \)\)\}"\)/);
    assert.match(smoke, /--ak "client_timeout_sec=\$\{RUN_TIMEOUTS\[\$i\]\}"/);
    assert.doesNotMatch(smoke, /refusing one global client timeout/);
});

test("{§enterprise} the corpus runs as one Harbor job per budget group, each followed live", () => {
    assert.match(smoke, /GROUPS_ROOT="\.cache\/enterprise-groups"/);
    assert.match(smoke, /cp -a "\$dir" "\$GROUPS_ROOT\/\$budget\/"/);
    assert.match(smoke, /for i in "\$\{!RUN_PATHS\[@\]\}"; do/);
    assert.match(smoke, /-k "\$TRIALS" -n "\$JOBS" -o "\$JOBS_ROOT" --yes &/);
    assert.match(smoke, /wait "\$HARBOR_PID" \|\|/);
});

test("{§publish}{§publish} job scratch lives under the benchmarks home and every trial publishes as it lands", () => {
    assert.match(smoke, /JOBS_ROOT="\$\(node src\/publish\.ts --jobs enterprise\)"/);
    assert.match(smoke, /PLURNK_BENCH_HARNESS=enterprise node src\/publish\.ts --watch "\$JOB" --pid "\$HARBOR_PID"/);
    assert.doesNotMatch(smoke, /-o jobs\b|ls -dt jobs\//);
});

test("{§config-carry} the runner uses the ordinary PLURNK_MODEL cascade", () => {
    assert.match(smoke, /source_env_file "\$OPERATOR_ENV"\nsource_env_file "\.env\.defaults"/);
    assert.match(smoke, /MODEL="\$PLURNK_MODEL"/);
    assert.doesNotMatch(smoke, /PLURNK_BENCH_MODEL|\$\{2:/);
});
}

// ─── specimen.test.ts ───
{
const specimen = readFileSync(new URL("./specimen.sh", import.meta.url), "utf8");

test("{§enterprise} the daemon comes from a checkout, the benchmark keeps its endpoint and judge", () => {
    assert.match(specimen, /node scripts\/candidate\.mjs --json --yolo --capabilities '\{"deny":\[\{"traits":\["web"\]\}\]\}' --project-root '' --timeout "\$TIMEOUT" -- "\$INSTRUCTION"/);
    assert.match(specimen, /docker run -d --rm --name "\$CONTAINER" -p 127\.0\.0\.1:8000:8000 "\$BENCH_IMAGE"/);
    assert.match(specimen, /docker cp "\$TASK_PATH\/tests\/\." "\$CONTAINER:\/tests\/"/);
    assert.match(specimen, /python -m utils\.test_helpers/);
    assert.match(specimen, /docker cp "\$CONTAINER:\/logs\/verifier\/\." "\$RUN_DIR\/verifier\/"/);
});

test("{§enterprise} the specimen carries the Harbor posture and records provenance", () => {
    assert.match(specimen, /PLURNK_EXECS_ONLY="sh,pm,crm,fileserver"/);
    for (const [name, port] of [["pm", 8011], ["crm", 8012], ["fileserver", 8013]] as const) {
        assert.ok(specimen.includes(`export PLURNK_MCP_${name}='${JSON.stringify({ name, type: "streamable-http", url: `http://127.0.0.1:${port}/mcp` })}'`));
    }
    assert.match(specimen, /export PLURNK_MCP_ENABLED=1/);
    assert.match(specimen, /export XDG_CONFIG_HOME="\$CONFIG_ROOT" PLURNK_SERVICE_ROOTS=plurnk/, "the candidate uses its isolated configuration root");
    assert.match(specimen, /PLURNK_MCP_EXPANDED='\["pm","crm","fileserver"\]'/);
    assert.match(specimen, /\["enterprise-specimen", process\.argv\[2\], process\.argv\[3\]\]/);
    assert.match(specimen, /service_dirty=/);
    assert.match(specimen, /source_env_file "\$OPERATOR_ENV"\nsource_env_file "\.env\.defaults"/);
    assert.match(specimen, /MODEL="\$PLURNK_MODEL"/);
    assert.doesNotMatch(specimen, /PLURNK_(?:BENCH|CANDIDATE)_MODEL|\$\{2:/);
});
}
