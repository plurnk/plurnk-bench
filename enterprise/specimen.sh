#!/usr/bin/env bash
# Enterprise-Bench specimen (SPEC §enterprise-specimen): run ONE task against a daemon built from
# a CHECKOUT — unreleased engine and teaching — while the benchmark keeps its own truth: the task
# container hosts the submission endpoint and runs the official judge over the pinned tests.
#
# The daemon and client run on this host (scripts/candidate.mjs in the service checkout), so the
# model's shell commands run HERE, not in a container. That is the price of testing unreleased
# code; the Harbor path (enterprise/smoke.sh) is the isolated, publishable one.
#
# Usage: enterprise/specimen.sh <task> [model-alias]
#   PLURNK_BENCHLET_SERVICE_ROOT   service checkout (default: ../plurnk-service)
#   PLURNK_CLIENT_CHECKOUT         client checkout (default: ../plurnk)
#   PLURNK_CANDIDATE_SKIP_BUILD    =1 to reuse the checkouts' dist
#   PLURNK_BENCH_TIMEOUT_SEC       override the client timeout (default: task budget − 30 s)
set -euo pipefail
cd "$(dirname "$0")/.."

TASK="${1:?usage: enterprise/specimen.sh <task> [model-alias]}"
MODEL="${2:-${PLURNK_BENCH_MODEL:-rtx5070}}"
BENCH_ROOT=".cache/enterprise-bench"
BENCH_IMAGE="enterprise-bench/conversational-base:latest"
SERVICE_ROOT="$(cd "${PLURNK_BENCHLET_SERVICE_ROOT:-../plurnk-service}" && pwd)"
CLIENT_ROOT="$(cd "${PLURNK_CLIENT_CHECKOUT:-../plurnk}" && pwd)"
TASK_PATH="$BENCH_ROOT/tasks/$TASK"
[ -f "$TASK_PATH/task.toml" ] || { echo "specimen: unknown task $TASK (run enterprise/smoke.sh once to pin the corpus)" >&2; exit 1; }
[ -n "${OPENAI_API_KEY:-}" ] || { echo "specimen: OPENAI_API_KEY is absent; the Enterprise-Bench judge cannot run" >&2; exit 1; }
docker image inspect "$BENCH_IMAGE" >/dev/null 2>&1 || { echo "specimen: $BENCH_IMAGE is not built (enterprise/smoke.sh builds it)" >&2; exit 1; }
for port in 8011 8012 8013; do curl -s -o /dev/null "http://127.0.0.1:$port/mcp" || { echo "specimen: MCP service on $port is down (make -C $BENCH_ROOT start-servers)" >&2; exit 1; }; done

BUDGET="$(awk -F= '/^\[/{s=$0} s=="[agent]" && $1 ~ /timeout_sec/ {v=$2; gsub(/[^0-9.]/,"",v); print int(v)}' "$TASK_PATH/task.toml")"
TIMEOUT="${PLURNK_BENCH_TIMEOUT_SEC:-$(( BUDGET - 30 ))}"
HOME_DIR="$(node src/publish.ts --home)"
RUN_DIR="$(node -e 'import("./src/run-directory.ts").then((m) => console.log(m.allocateRunDirectory(process.argv[1], ["enterprise-specimen", process.argv[2], process.argv[3]])))' "$HOME_DIR" "$TASK" "$MODEL")"
echo "specimen: task=$TASK model=$MODEL timeout=${TIMEOUT}s (budget ${BUDGET}s) service=$SERVICE_ROOT@$(git -C "$SERVICE_ROOT" rev-parse --short HEAD) client=$CLIENT_ROOT@$(git -C "$CLIENT_ROOT" rev-parse --short HEAD) run=$RUN_DIR" >&2
{
  echo "task=$TASK"; echo "model=$MODEL"; echo "timeout_sec=$TIMEOUT"
  echo "service=$(git -C "$SERVICE_ROOT" rev-parse HEAD) $(git -C "$SERVICE_ROOT" branch --show-current)"
  echo "service_dirty=$(git -C "$SERVICE_ROOT" status --porcelain | wc -l)"
  echo "client=$(git -C "$CLIENT_ROOT" rev-parse HEAD) $(git -C "$CLIENT_ROOT" branch --show-current)"
  echo "corpus=$(git -C "$BENCH_ROOT" rev-parse HEAD)"
} > "$RUN_DIR/provenance.txt"

# The task container: the benchmark's submission endpoint (uvicorn on :8000) and, later, its judge.
CONTAINER="enterprise-specimen-$$"
docker run -d --rm --name "$CONTAINER" -p 127.0.0.1:8000:8000 "$BENCH_IMAGE" >/dev/null
trap 'docker stop "$CONTAINER" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8000/health >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://127.0.0.1:8000/health >/dev/null || { echo "specimen: task container did not become healthy" >&2; exit 1; }
docker cp "$TASK_PATH/tests/." "$CONTAINER:/tests/"

# The same posture the Harbor driver carries (SPEC §enterprise-posture), on a host daemon.
export PLURNK_CANDIDATE_MODEL="$MODEL"
export PLURNK_MCP_PM="http://127.0.0.1:8011/mcp" PLURNK_MCP_CRM="http://127.0.0.1:8012/mcp" PLURNK_MCP_FILESERVER="http://127.0.0.1:8013/mcp"
export PLURNK_MCP_ENABLED='["pm","crm","fileserver"]' PLURNK_MCP_EXPANDED='["pm","crm","fileserver"]'
export PLURNK_EXECS_ONLY="sh,pm,crm,fileserver" PLURNK_SERVICE_MAX_EMBED_SIZE=262144
export PLURNK_CLIENT_CHECKOUT="$CLIENT_ROOT" PLURNK_BENCHMARKS="$HOME_DIR" PLURNK_CANDIDATE_DIR="$RUN_DIR"
INSTRUCTION="$(cat "$TASK_PATH/instruction.md")"
set +e
( cd "$SERVICE_ROOT" && node scripts/candidate.mjs --json --auto --flags '{"noWeb": true, "noInteraction": true}' --project-root '' --timeout "$TIMEOUT" -- "$INSTRUCTION" ) > "$RUN_DIR/candidate.stdout" 2> "$RUN_DIR/candidate.stderr"
echo "candidate_exit=$?" >> "$RUN_DIR/provenance.txt"
set -e
# The client's --json document leads the candidate's stdout; the digest's own line follows it.
node -e '
const raw = require("node:fs").readFileSync(process.argv[1], "utf8");
let depth = 0, end = -1, inString = false, escaped = false;
for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === "\"") inString = false; continue; }
  if (c === "\"") inString = true; else if (c === "{") depth++; else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (end < 0) throw new Error("no client document on candidate stdout");
require("node:fs").writeFileSync(process.argv[2], raw.slice(0, end) + "\n");
' "$RUN_DIR/candidate.stdout" "$RUN_DIR/plurnk.json"

# The official judge, exactly as Harbor's verifier runs it, over the pinned criteria.
docker cp "$CONTAINER:/agent-logs/conversational/responses.jsonl" "$RUN_DIR/responses.jsonl" 2>/dev/null || : > "$RUN_DIR/responses.jsonl"
set +e
docker exec -e "OPENAI_API_KEY=$OPENAI_API_KEY" "$CONTAINER" sh -c 'cd /workspace && python -m utils.test_helpers' > "$RUN_DIR/judge.stdout" 2> "$RUN_DIR/judge.stderr"
echo "judge_exit=$?" >> "$RUN_DIR/provenance.txt"
set -e
mkdir -p "$RUN_DIR/verifier"
docker cp "$CONTAINER:/logs/verifier/." "$RUN_DIR/verifier/" 2>/dev/null || true
echo "specimen: reward=$(cat "$RUN_DIR/verifier/reward.txt" 2>/dev/null || echo '?') submitted=$([ -s "$RUN_DIR/responses.jsonl" ] && echo yes || echo no) → $RUN_DIR" >&2
