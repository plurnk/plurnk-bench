import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const specimen = readFileSync(new URL("./specimen.sh", import.meta.url), "utf8");

test("[§enterprise-specimen] the daemon comes from a checkout, the benchmark keeps its endpoint and judge", () => {
    assert.match(specimen, /node scripts\/candidate\.mjs --json --auto --flags '\{"noWeb": true, "noInteraction": true\}' --project-root '' --timeout "\$TIMEOUT" -- "\$INSTRUCTION"/);
    assert.match(specimen, /docker run -d --rm --name "\$CONTAINER" -p 127\.0\.0\.1:8000:8000 "\$BENCH_IMAGE"/);
    assert.match(specimen, /docker cp "\$TASK_PATH\/tests\/\." "\$CONTAINER:\/tests\/"/);
    assert.match(specimen, /python -m utils\.test_helpers/);
    assert.match(specimen, /docker cp "\$CONTAINER:\/logs\/verifier\/\." "\$RUN_DIR\/verifier\/"/);
});

test("[§enterprise-specimen] the specimen carries the Harbor posture and records provenance", () => {
    assert.match(specimen, /PLURNK_EXECS_ONLY="sh,pm,crm,fileserver" PLURNK_SERVICE_MAX_EMBED_SIZE=262144/);
    assert.match(specimen, /PLURNK_MCP_ENABLED='\["pm","crm","fileserver"\]' PLURNK_MCP_EXPANDED='\["pm","crm","fileserver"\]'/);
    assert.match(specimen, /\["enterprise-specimen", process\.argv\[2\], process\.argv\[3\]\]/);
    assert.match(specimen, /service_dirty=/);
    assert.match(specimen, /source_env_file "\$OPERATOR_ENV"\nsource_env_file "\.env\.defaults"/);
    assert.match(specimen, /MODEL="\$PLURNK_MODEL"/);
    assert.doesNotMatch(specimen, /PLURNK_(?:BENCH|CANDIDATE)_MODEL|\$\{2:/);
});
