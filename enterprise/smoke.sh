#!/usr/bin/env bash
# Enterprise-Bench runner (SPEC §enterprise): drive DevRev Enterprise-Bench L1-L2 tasks through
# plurnk under Harbor. Reads the AUTHORITATIVE daemon config IN PLACE — bench re-declares nothing:
#   • model layer   ← $XDG_CONFIG_HOME/plurnk/.env (aliases and model controls)
#   • provider env  ← your shell        (.bashrc: keys, endpoints)
#   • judge key     ← your shell        (OPENAI_API_KEY — Harbor interpolates the task's [verifier.env])
# and forwards the MINIMAL manifest to the in-container daemon via --agent-env: the model layer for
# the run's alias plus its provider credentials, nothing else. The benchmark declares its own MCP
# services (mcp.json) and Harbor hands them to the driver, which re-hosts them for a Linux host and
# declares them as plurnk HTTP MCP servers. The operator's MCP fleet never rides (SPEC §enterprise-mcp-carry).
#
# Usage: enterprise/smoke.sh [task|all] [model-alias]
#   task         one task directory name (default: eng-l1-a); `all` runs the 14-task corpus
#   model-alias  default: PLURNK_MODEL from the XDG user config (e.g. deepdumb, glm)
#
# Bench's own knobs are namespaced PLURNK_BENCH_ (SPEC §config-bench-namespace — never forwarded to the daemon):
#   PLURNK_BENCH_PROFILE      single (1 trial/task, default) | comparison (3) | canonical (10) — SPEC §enterprise-profiles
#   PLURNK_BENCH_JOBS         concurrent trials (default 3 — each task container reserves 2 GB)
#   PLURNK_BENCH_TIMEOUT_SEC  override the client timeout (default: task's [agent] budget − headroom)
#   PLURNK_BENCH_FORCE_BUILD  =1 to force an agent-image rebuild
#   PLURNK_BENCH_NO_GBNF      =1 to drop PLURNK_PROVIDERS_GBNF (for models that can't enforce it)
set -euo pipefail
cd "$(dirname "$0")/.."

# SPEC §enterprise-provenance — the exact upstream corpus this family measures.
BENCH_REPOSITORY="https://github.com/devrev/enterprise-bench"
BENCH_COMMIT="5a79ad04237d786414be0473da79fb1754574aff"
BENCH_ROOT=".cache/enterprise-bench"
BENCH_IMAGE="enterprise-bench/conversational-base:latest"
MCP_PORTS="8011 8012 8013"
# Daemon boot + DB snapshot take well under 10 s; agent setup is outside the task's [agent] budget.
HEADROOM_SEC=30

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
case "$CONFIG_HOME" in /*) ;; *) CONFIG_HOME="$HOME/.config";; esac
OPERATOR_ENV="$CONFIG_HOME/plurnk/.env"
[ -r "$OPERATOR_ENV" ] || { echo "enterprise: operator config is missing: $OPERATOR_ENV" >&2; exit 1; }
source_env_file() {
  eval "$(node -e '
    const { parseEnv } = require("node:util");
    const parsed = parseEnv(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const [key, value] of Object.entries(parsed))
      console.log("export " + key + "=" + "\x27" + value.replaceAll("\x27", "\x27\\\x27\x27") + "\x27");
  ' "$1")"
}
source_env_file "$OPERATOR_ENV"

TASK="${1:-eng-l1-a}"
MODEL="${2:-${PLURNK_MODEL:?set PLURNK_MODEL in $OPERATOR_ENV or pass a model alias}}"
PROFILE="${PLURNK_BENCH_PROFILE:-single}"
case "$PROFILE" in
  single) TRIALS=1;;
  comparison) TRIALS=3;;
  canonical) TRIALS=10;;
  *) echo "enterprise: PLURNK_BENCH_PROFILE must be single, comparison, or canonical" >&2; exit 1;;
esac
JOBS="${PLURNK_BENCH_JOBS:-3}"
# The judge is the benchmark's, not ours: refuse before any spend rather than score a
# missing key as an agent failure (SPEC §enterprise-oracle).
[ -n "${OPENAI_API_KEY:-}" ] || { echo "enterprise: OPENAI_API_KEY is absent; the Enterprise-Bench judge cannot run" >&2; exit 1; }
for tool in harbor docker node npm unzip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "enterprise: $tool is required" >&2; exit 1; }
done

# ---- corpus: pinned clone, extracted artifacts, base image, MCP services (idempotent) ----
if [ ! -d "$BENCH_ROOT/.git" ]; then
  git clone --quiet "$BENCH_REPOSITORY" "$BENCH_ROOT"
fi
git -C "$BENCH_ROOT" fetch --quiet origin "$BENCH_COMMIT" 2>/dev/null || true
git -C "$BENCH_ROOT" checkout --quiet --detach "$BENCH_COMMIT"
[ "$(git -C "$BENCH_ROOT" rev-parse HEAD)" = "$BENCH_COMMIT" ] || { echo "enterprise: corpus is not at $BENCH_COMMIT" >&2; exit 1; }
[ -z "$(git -C "$BENCH_ROOT" status --porcelain --untracked-files=no)" ] || { echo "enterprise: corpus checkout is modified; refusing" >&2; exit 1; }
make -C "$BENCH_ROOT" -s setup >/dev/null
if [ -n "${PLURNK_BENCH_FORCE_BUILD:-}" ] || ! docker image inspect "$BENCH_IMAGE" >/dev/null 2>&1; then
  make -C "$BENCH_ROOT" -s build-image >/dev/null
fi
services_up() {
  for port in $MCP_PORTS; do
    curl -s -o /dev/null "http://127.0.0.1:$port/mcp" || return 1
  done
}
services_up || make -C "$BENCH_ROOT" -s start-servers >/dev/null
for _ in $(seq 1 60); do services_up && break; sleep 1; done
services_up || { echo "enterprise: MCP services did not come up on $MCP_PORTS" >&2; exit 1; }

# Task selection: one task directory, or the whole corpus.
if [ "$TASK" = all ]; then
  TASK_PATH="$BENCH_ROOT/tasks"
else
  TASK_PATH="$BENCH_ROOT/tasks/$TASK"
  [ -f "$TASK_PATH/task.toml" ] || { echo "enterprise: unknown task $TASK" >&2; exit 1; }
fi

# Give the agent the BENCHMARK's own budget, not an arbitrary cap (SPEC §config-budget):
# every task's [agent] timeout_sec, minus headroom (daemon boot + DB snapshot) — the model gets
# the whole budget the benchmark grants; an arbitrary shorter cap understates every result.
if [ "$TASK" = all ]; then BUDGET_FILES=("$TASK_PATH"/*/task.toml); else BUDGET_FILES=("$TASK_PATH/task.toml"); fi
AGENT_BUDGET="$(awk -F= '/^\[/{s=$0} s=="[agent]" && $1 ~ /timeout_sec/ {v=$2; gsub(/[^0-9.]/,"",v); print int(v)}' "${BUDGET_FILES[@]}" | sort -u)"
[ "$(printf '%s\n' "$AGENT_BUDGET" | wc -l)" -eq 1 ] || {
  echo "enterprise: task budgets are not uniform ($(echo $AGENT_BUDGET)); refusing one global client timeout" >&2; exit 1;
}
CLIENT_TIMEOUT_SEC="${PLURNK_BENCH_TIMEOUT_SEC:-$(( AGENT_BUDGET - HEADROOM_SEC ))}"

# The task container reaches the host's MCP services by the host LAN IP: mcp.json says
# host.docker.internal, which Linux Docker does not resolve. The driver rewrites it.
MCP_HOST="$(hostname -I | awk '{print $1}')"

# Minimal manifest: the model layer for the run's alias + its provider credentials, derived
# from the authoritative alias definition + the shipped provider registry. Emits one
# `KEY=VALUE` per provider credential that is set.
MANIFEST="$(MODEL="$MODEL" node -e '
  const providers = require("./node_modules/@plurnk/plurnk-models/dist/providers.json");
  const keys = new Set();
  for (const alias of [process.env.MODEL, process.env.PLURNK_MODEL_CHILD].filter(Boolean)) {
    const def = process.env["PLURNK_MODEL_" + alias] ?? (alias.includes("/") ? alias : null);
    if (!def) throw new Error("alias " + alias + " has no PLURNK_MODEL_" + alias + " definition");
    const provider = providers[def.split("/")[0]];
    if (!provider) throw new Error("unknown provider in " + def);
    for (const key of provider.env ?? []) keys.add(key);
  }
  const lines = [];
  for (const key of keys) if (process.env[key]) lines.push(key + "=" + process.env[key]);
  console.log(lines.join("\n"));
')"
flags=(--agent-env "PLURNK_MODEL=$MODEL")
[ -n "${PLURNK_MODEL_CHILD:-}" ] && flags+=(--agent-env "PLURNK_MODEL_CHILD=$PLURNK_MODEL_CHILD")
for alias in "$MODEL" "${PLURNK_MODEL_CHILD:-}"; do
  [ -n "$alias" ] || continue
  for k in $(compgen -v | grep -E "^PLURNK_(MODEL|PROVIDERS_[A-Z_]+)_${alias}$"); do
    flags+=(--agent-env "$k=${!k}")
  done
done
while IFS= read -r line; do
  [ -n "$line" ] && flags+=(--agent-env "$line")
done <<< "$MANIFEST"
# SPEC §config-gbnf-optout: forward =0 to override the container's shipped default.
[ -n "${PLURNK_BENCH_NO_GBNF:-}" ] && flags+=(--agent-env "PLURNK_PROVIDERS_GBNF=0")

# Resolve immutable versions before Harbor constructs the agent image (SPEC §config-package-version).
SERVICE_VERSION="$(npm view @plurnk/plurnk-service version 2>/dev/null)"
CLIENT_VERSION="$(npm view @plurnk/plurnk version 2>/dev/null)"
[ -n "$SERVICE_VERSION" ] && [ -n "$CLIENT_VERSION" ] || {
  echo "enterprise: cannot resolve current @plurnk publications" >&2
  exit 1
}

echo "enterprise: model=$MODEL task=$TASK profile=$PROFILE trials=$TRIALS jobs=$JOBS service=$SERVICE_VERSION client=$CLIENT_VERSION mcp_host=$MCP_HOST client_timeout=${CLIENT_TIMEOUT_SEC}s (budget ${AGENT_BUDGET}s)${PLURNK_BENCH_FORCE_BUILD:+ [force-build]}" >&2
# The default personality ships on; PLURNK_POLICY stays unset so the benchmark gets the product default.
PYTHONPATH=enterprise harbor run -p "$TASK_PATH" \
  -a driver:PlurnkAgent \
  -m "plurnk/$MODEL" \
  --mcp-config "$BENCH_ROOT/mcp.json" \
  --ak "client_timeout_sec=$CLIENT_TIMEOUT_SEC" \
  --ak "service_version=$SERVICE_VERSION" \
  --ak "client_version=$CLIENT_VERSION" \
  --ak "mcp_host=$MCP_HOST" \
  "${flags[@]}" \
  -k "$TRIALS" -n "$JOBS" -o jobs --yes

# Publish every trial of the job to the shared benchmarks tree (<plurnk>/benchmarks/run<N>),
# banking the requiem under the full authoritative provider config in a subshell so those
# defaults never leak back into the forwarding above.
(
  for f in node_modules/@plurnk/*/.env.defaults; do [ -f "$f" ] && source_env_file "$f"; done
  source_env_file "$OPERATOR_ENV"
  export PLURNK_MODEL="$MODEL"
  PLURNK_BENCH_HARNESS=enterprise node src/publish.ts "$(ls -dt jobs/*/ | head -1)"
)
