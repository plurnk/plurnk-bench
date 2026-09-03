#!/usr/bin/env bash
# FrontierHarness Eval v1 parity run (#22): the 30 tasks of terminal_bench/frontier.manifest.json
# (21 Terminal-Bench 2.1 + 9 DeepSWE v1.1), one Harbor job per task through the plurnk agent,
# each client timeout = the task's own [agent] budget minus headroom (SPEC §frontier-parity).
#   PLURNK_MODEL=<alias> terminal_bench/frontier.sh [--preflight] [task ...]
#   PLURNK_BENCH_JOBS      tasks in flight at once (default 4)
#   PLURNK_BENCH_SERVICE_VERSION / _CLIENT_VERSION   the published @plurnk versions the agent installs
#                          in every container (default: the registry's latest at launch, resolved once and recorded)
#   PLURNK_BENCH_RUNS_DIR  where run directories land (default jobs/)
#   PLURNK_BENCH_EMBEDDING_ROUTE / _BASE_URL   the container's embedding route (SPEC §config-embedding-route):
#                          absent or 'bundled' = the daemon's bundled wasm model; a hosted route such as
#                          local-embed/sentence-transformers/all-MiniLM-L6-v2 on https://embed.plurnk.ai/v1
# Provider keys are exports in the operator's shell: launch as `bash -lic '…'`.
# Corpus state (downloaded, never committed):
#   harbor dataset download terminal-bench/terminal-bench-2-1 -o .cache/terminal-bench-2-1
#   the DeepSWE task cache under .cache/deep-swe/tasks (deepswe/README.md)
set -euo pipefail
cd "$(dirname "$0")/.."

PREFLIGHT=0
ONLY=()
for arg in "$@"; do
  case "$arg" in
    --preflight) PREFLIGHT=1 ;;
    --*) echo "frontier: unknown flag $arg" >&2; exit 2 ;;
    *) ONLY+=("$arg") ;;
  esac
done

PLAN="$(node terminal_bench/frontier.mjs plan)"
if [ "${#ONLY[@]}" -gt 0 ]; then
  PLAN="$(printf '%s\n' "$PLAN" | node -e '
    const only = new Set(process.argv.slice(1));
    const rows = require("node:fs").readFileSync(0, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const unknown = [...only].filter((task) => !rows.some((row) => row.task === task));
    if (unknown.length) { console.error(`frontier: not in the manifest: ${unknown.join(", ")}`); process.exit(2); }
    for (const row of rows) if (only.has(row.task)) console.log(JSON.stringify(row));
  ' "${ONLY[@]}")"
fi

printf '%s\n' "$PLAN" | node -e '
  const rows = require("node:fs").readFileSync(0, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  for (const row of rows) console.log(`${row.source.padEnd(14)} ${row.task.padEnd(40)} budget=${row.budget}s client=${row.client_timeout_sec}s image=${row.image}`);
  console.log(`frontier: ${rows.length} task(s) planned`);
'
if [ "$PREFLIGHT" = 1 ]; then exit 0; fi

MODEL="${PLURNK_MODEL:-}"
[ -n "$MODEL" ] || { echo "frontier: PLURNK_MODEL=<alias> selects the model (the agent resolves its layer from the operator XDG config)" >&2; exit 2; }
RUN="${PLURNK_BENCH_RUNS_DIR:-jobs}/frontier-${MODEL}-$(date +%Y%m%d-%H%M%S)"
export MODEL RUN
# One run, one pinned platform: resolve the published versions once so every container installs
# the same artifacts and the record names them (a credible run never installs "latest" thirty times).
SERVICE_VERSION="${PLURNK_BENCH_SERVICE_VERSION:-$(npm view @plurnk/plurnk-service version 2>/dev/null)}"
CLIENT_VERSION="${PLURNK_BENCH_CLIENT_VERSION:-$(npm view @plurnk/plurnk version 2>/dev/null)}"
[ -n "$SERVICE_VERSION" ] && [ -n "$CLIENT_VERSION" ] || { echo "frontier: could not resolve the published @plurnk versions (set PLURNK_BENCH_SERVICE_VERSION and _CLIENT_VERSION)" >&2; exit 2; }
export SERVICE_VERSION CLIENT_VERSION
mkdir -p "$RUN"
cp terminal_bench/frontier.manifest.json "$RUN/manifest.json"
printf '%s\n' "$PLAN" > "$RUN/plan.jsonl"
{
  echo "model=$MODEL"
  echo "model_route=$(grep -E "^PLURNK_MODEL_$MODEL=" "${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env" 2>/dev/null | cut -d= -f2-)"
  echo "model_knobs=$(grep -E "^PLURNK_PROVIDERS_[A-Z_]+_$MODEL=" "${XDG_CONFIG_HOME:-$HOME/.config}/plurnk/.env" 2>/dev/null | tr '\n' ' ')"
  echo "service_version=$SERVICE_VERSION"
  echo "client_version=$CLIENT_VERSION"
  echo "embedding_route=${PLURNK_BENCH_EMBEDDING_ROUTE:-bundled}"
  echo "jobs=${PLURNK_BENCH_JOBS:-4}"
  echo "harbor=$(harbor --version 2>/dev/null | head -1)"
  echo "started=$(date -Iseconds)"
  echo "manifest_sha256=$(sha256sum terminal_bench/frontier.manifest.json | cut -d' ' -f1)"
} > "$RUN/provenance.txt"
echo "frontier: run directory $RUN"

# One Harbor job per task: its own client budget, its own job dir, the shared run.
printf '%s\n' "$PLAN" | node -e '
  const rows = require("node:fs").readFileSync(0, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  for (const row of rows) console.log([row.task, row.dir, row.client_timeout_sec].join("\t"));
' | xargs -P "${PLURNK_BENCH_JOBS:-4}" -L 1 bash -c '
  task="$0"; dir="$1"; budget="$2"
  echo "frontier: launch $task (client_timeout_sec=$budget)"
  terminal_bench/run.sh -p "$dir" -m "$MODEL" --agent-kwarg "client_timeout_sec=$budget" \
    --agent-kwarg "service_version=$SERVICE_VERSION" --agent-kwarg "client_version=$CLIENT_VERSION" \
    --jobs-dir "$RUN" --job-name "$task" -n 1 > "$RUN/$task.launch.log" 2>&1 \
    || echo "frontier: $task launcher exited $? (see $RUN/$task.launch.log)"
' 2>&1
node terminal_bench/frontier.mjs summary "$RUN" | tee "$RUN/summary.txt"
