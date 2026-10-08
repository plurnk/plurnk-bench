import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const specimen = readFileSync(new URL("./specimen.sh", import.meta.url), "utf8");

test("[§enterprise-specimen] the daemon comes from a checkout, the benchmark keeps its endpoint and judge", () => {
    assert.match(specimen, /node scripts\/candidate\.mjs --json --yolo --capabilities '\{"deny":\[\{"traits":\["web"\]\}\]\}' --project-root '' --timeout "\$TIMEOUT" -- "\$INSTRUCTION"/);
    assert.match(specimen, /docker run -d --rm --name "\$CONTAINER" -p 127\.0\.0\.1:8000:8000 "\$BENCH_IMAGE"/);
    assert.match(specimen, /docker cp "\$TASK_PATH\/tests\/\." "\$CONTAINER:\/tests\/"/);
    assert.match(specimen, /python -m utils\.test_helpers/);
    assert.match(specimen, /docker cp "\$CONTAINER:\/logs\/verifier\/\." "\$RUN_DIR\/verifier\/"/);
});

test("[§enterprise-specimen] the specimen carries the Harbor posture and records provenance", () => {
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
