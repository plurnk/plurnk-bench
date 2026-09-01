#!/usr/bin/env bash
# Diagnostic smoke (SPEC §config-carry): drive one DeepSWE task through plurnk. Reads the AUTHORITATIVE daemon
# config IN PLACE — bench re-declares nothing:
#   • model choice  ← shell, then $XDG_CONFIG_HOME/plurnk/.env, then .env.defaults
#   • alias tuning  ← $XDG_CONFIG_HOME/plurnk/.env
#   • provider env  ← your shell        (.bashrc: OPENAI_BASE_URL, XAI_*, keys, …)
# and forwards it to the in-container daemon via --agent-env (Pier does NOT interpolate
# ${VAR} in --config — that resolver is dead code). A *_BASE_URL on host loopback is
# rewritten to the host LAN IP, the one container-boundary transform (the container can't
# reach the host's 127.0.0.1, but reaches the same 0.0.0.0-bound server on the LAN).
#
# Usage: deepswe/smoke.sh [task-glob|all]
#   task-glob    default: abs-module-cache-flags; `all` runs the FULL corpus (official mode)
#   model        selected by the ordinary PLURNK_MODEL cascade
#
# `all` is the official-corpus mode: it forwards the MINIMAL manifest — the model layer for
# the run's aliases plus their provider credentials, nothing else. No MCP fleet, no web
# keys, no foreign provider credentials inside a container that executes model-authored
# commands; Tavily is forced absent (contamination honesty). Single-task mode keeps
# operator-config parity for diagnostics, minus the MCP fleet (structurally dead under the
# schema-1.3 egress wall — booting servers whose traffic cannot pass only distorts runs).
#
# Bench's own knobs are namespaced PLURNK_BENCH_ (SPEC §config-bench-namespace — never forwarded to the daemon):
#   PLURNK_BENCH_TIMEOUT_SEC  override the client timeout (default: task's [agent] budget − headroom)
#   PLURNK_BENCH_CPUS         override container cpus (default: task native — leaderboard-compliant)
#   PLURNK_BENCH_FORCE_BUILD  =1 to force an agent-image rebuild (base-image/debug escape hatch)
#   PLURNK_BENCH_NO_GBNF      =1 to drop PLURNK_PROVIDERS_GBNF (for models that can't enforce it, e.g. xai)
#   PLURNK_BENCH_JOBS         `all` mode concurrency (default 4)
#   (every run samples docker stats once a minute into <job>/docker-stats.jsonl — SPEC §config-resource-samples)
#   (every run first pre-pulls its task images via deepswe/prepull.sh — SPEC §config-image-prepull — and refuses
#    to start trials without them; the bench's own @plurnk/plurnk-service must equal the corpus's — SPEC §config-digest-preflight)
#   PLURNK_BENCH_EMBEDDING_ROUTE, PLURNK_BENCH_EMBEDDING_BASE_URL
#                             the public embedding route EVERY mode forwards (SPEC §config-embedding-route)
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
case "$CONFIG_HOME" in /*) ;; *) CONFIG_HOME="$HOME/.config";; esac
OPERATOR_ENV="$CONFIG_HOME/plurnk/.env"
[ -r "$OPERATOR_ENV" ] || { echo "smoke: operator config is missing: $OPERATOR_ENV" >&2; exit 1; }
# Model layer; provider env already present via .bashrc. The daemon reads .env with
# Node's parseEnv semantics — values with spaces/parens are legal there and blow up a
# bash `source`, so parse it the way the product does and re-emit shell-safe exports.
source_env_file() {
  eval "$(node -e '
    const { parseEnv } = require("node:util");
    const parsed = parseEnv(require("node:fs").readFileSync(process.argv[1], "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (Object.hasOwn(process.env, key)) continue;
      console.log("export " + key + "=" + "\x27" + value.replaceAll("\x27", "\x27\\\x27\x27") + "\x27");
    }
  ' "$1")"
}
source_env_file "$OPERATOR_ENV"
source_env_file ".env.defaults"
# Transport (service 1.0.0): single listener — PLURNK_PORT=1066 is THE client surface
# (AG-UI); the separate WS listener is gone. The in-container daemon+client pair share the
# shipped default, so bench sets NOTHING here (a stale port export silently kills the loop).
[ "$#" -le 1 ] || { echo "usage: deepswe/smoke.sh [task-glob|all]" >&2; exit 2; }
TASK="${1:-abs-module-cache-flags}"
# Corpus records are clean, publishable results (#15): requiems are a benchlet
# instrument; all mode refuses the knob loudly rather than honoring or ignoring it.
if [ "$TASK" = all ] && [ "${PLURNK_BENCH_REQUIEM:-0}" = "1" ]; then
  echo "smoke: requiems are a benchlet instrument — corpus records stay clean; unset PLURNK_BENCH_REQUIEM (#15)" >&2
  exit 1
fi
# SPEC §config-model-default: shell, then XDG operator config, then the committed floor.
MODEL="$PLURNK_MODEL"
LAN_IP="$(hostname -I | awk '{print $1}')"

# Give the agent the BENCHMARK's own budget, not an arbitrary cap: read the task's
# [agent] timeout_sec and use it minus headroom (daemon boot + commit + DB copy). A
# shorter client --timeout would starve the model below the benchmark's intended
# allowance and understate every result (SPEC §config-budget). Override with PLURNK_BENCH_TIMEOUT_SEC for quick dev.
if [ "$TASK" = all ]; then
  # One global client timeout is only honest if every task grants the same budget.
  AGENT_BUDGET="$(awk -F= '/^\[/{s=$0} s=="[agent]" && $1 ~ /timeout_sec/ {v=$2; gsub(/[^0-9.]/,"",v); print int(v)}' .cache/deep-swe/tasks/*/task.toml | sort -u)"
  [ "$(printf '%s\n' "$AGENT_BUDGET" | wc -l)" -eq 1 ] || {
    echo "smoke: task budgets are not uniform ($(echo $AGENT_BUDGET)); refusing one global client timeout" >&2; exit 1;
  }
else
  TASKDIR="$(ls -d ".cache/deep-swe/tasks/$TASK"*/ 2>/dev/null | head -1)"
  AGENT_BUDGET="$(awk -F= '/^\[/{s=$0} s=="[agent]" && $1 ~ /timeout_sec/ {v=$2; gsub(/[^0-9.]/,"",v); printf "%d", v}' "${TASKDIR}task.toml" 2>/dev/null)"
fi
CLIENT_TIMEOUT_SEC="${PLURNK_BENCH_TIMEOUT_SEC:-$(( ${AGENT_BUDGET:-1920} - 120 ))}"

# Runtime egress (schema 1.3): tasks are air-gapped; Pier grants the agent only a squid
# proxy (ports 80/443) over the driver's allowlist. Derive the provider hosts and
# credential names for the RUN'S aliases from the authoritative alias defs + the shipped
# provider registry — a cloud provider (deepseek) has no *_BASE_URL to inspect. Emits
# `DOMAINS=...` then one `KEY=VALUE` per provider credential that is set.
MANIFEST="$(MODEL="$MODEL" node -e '
  const providers = require("./node_modules/@plurnk/plurnk-models/dist/providers.json");
  const hosts = new Set(); const keys = new Set();
  for (const alias of [process.env.MODEL, process.env.PLURNK_MODEL_CHILD].filter(Boolean)) {
    const def = process.env["PLURNK_MODEL_" + alias] ?? (alias.includes("/") ? alias : null);
    if (!def) throw new Error("alias " + alias + " has no PLURNK_MODEL_" + alias + " definition");
    const provider = providers[def.split("/")[0]];
    if (!provider) throw new Error("unknown provider in " + def);
    for (const key of provider.env ?? []) keys.add(key);
    if (!provider.api) continue;   // SDK-native provider: driver fails loudly unless PLURNK_BASE_URL names the host
    const api = provider.api.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");
    hosts.add(new URL(api).hostname);
  }
  const lines = ["DOMAINS=" + [...hosts].join(",")];
  for (const key of keys) if (process.env[key]) lines.push(key + "=" + process.env[key]);
  console.log(lines.join("\n"));
')"
EGRESS_DOMAINS="$(printf '%s\n' "$MANIFEST" | head -1)"; EGRESS_DOMAINS="${EGRESS_DOMAINS#DOMAINS=}"

if [ "$TASK" = all ]; then
  # Official-corpus manifest: the model layer for the run's aliases + their provider
  # credentials, nothing else (see header). Alias-scoped knobs ride with their alias.
  flags=(--agent-env "PLURNK_MODEL=$MODEL")
  [ -n "${PLURNK_MODEL_CHILD:-}" ] && flags+=(--agent-env "PLURNK_MODEL_CHILD=$PLURNK_MODEL_CHILD")
  for alias in "$MODEL" "${PLURNK_MODEL_CHILD:-}"; do
    [ -n "$alias" ] || continue
    for k in $(compgen -v | grep -E "^PLURNK_(MODEL|PROVIDERS_[A-Z_]+)_${alias}$"); do
      flags+=(--agent-env "$k=${!k}")
    done
  done
  # Provider-scoped knobs ride with the providers the run's aliases resolve to —
  # alias tuning (REASONING_<alias>=low) is meaningless without the provider's
  # admitted-efforts/style lines (the 113×0 fleet refusal of 2026-08-31, #11).
  for prefix in $(for alias in "$MODEL" "${PLURNK_MODEL_CHILD:-}"; do
    [ -n "$alias" ] || continue
    def_var="PLURNK_MODEL_${alias}"; def="${!def_var:-$alias}"
    case "$def" in */*) printf '%s\n' "${def%%/*}" | tr -c 'A-Za-z0-9\n' '_' | tr 'a-z' 'A-Z';; esac
  done | sort -u); do
    for k in $(compgen -v | grep -E "^PLURNK_PROVIDERS_PROVIDER_${prefix}_"); do
      flags+=(--agent-env "$k=${!k}")
    done
  done
  while IFS= read -r line; do
    case "$line" in DOMAINS=*) ;; *) flags+=(--agent-env "$line");; esac
  done <<< "$MANIFEST"
else
  # Forward the DAEMON's config that already exists: every PLURNK_* (alias defs + GBNF) and
  # each provider *_BASE_URL / *_API_KEY that is set, rewriting host loopback → LAN for the
  # container. Bench's own PLURNK_BENCH_* knobs are orchestration, not daemon config — never
  # forward them. No hand-maintained manifest.
  flags=(--agent-env "PLURNK_MODEL=$MODEL")
  for k in $(compgen -v | grep -E '^PLURNK_|_BASE_URL$|_API_KEY$' | grep -v '^PLURNK_BENCH_'); do
    case "$k" in
      PLURNK_MODEL|PLURNK_MODEL_NAME) continue;;
      # The MCP fleet is structurally dead under the egress wall: its traffic cannot pass,
      # so booting the servers only distorts the run with connect noise. Never forward.
      PLURNK_MCP_*) continue;;
      # SPEC §config-embedding-route: the container embeds over the bench's public route (below),
      # never the operator's selection or profile facts — a loopback GPU server is unreachable,
      # and duplicate facts for a known route refuse the daemon's boot.
      PLURNK_EMBEDDING_*) continue;;
      # A non-llama backend (xai/openrouter) can't enforce GBNF; 0.70.0's daemon refuses to
      # boot with GBNF requested-but-unenforceable. PLURNK_BENCH_NO_GBNF=1 runs unconstrained.
      PLURNK_PROVIDERS_GBNF) [ -n "${PLURNK_BENCH_NO_GBNF:-}" ] && continue;;
    esac
    v="${!k:-}"; [ -n "$v" ] || continue
    case "$k" in *_BASE_URL)
      v="${v//127.0.0.1/$LAN_IP}"; v="${v//localhost/$LAN_IP}"
      # An explicit endpoint is model egress too: allowlist its host (squid still
      # only passes 80/443 — a nonstandard local port fails loudly at run time).
      h="${v#*://}"; h="${h%%[:/]*}"; EGRESS_DOMAINS="${EGRESS_DOMAINS:+$EGRESS_DOMAINS,}$h";;
    esac
    flags+=(--agent-env "$k=$v")
  done
  # SPEC §config-gbnf-optout: the container's shipped .env floor DEFAULTS PLURNK_PROVIDERS_GBNF=plurnk.gbnf, so merely
  # not forwarding it isn't enough — forward =0 to explicitly override the default OFF.
  [ -n "${PLURNK_BENCH_NO_GBNF:-}" ] && flags+=(--agent-env "PLURNK_PROVIDERS_GBNF=0")
fi

# SPEC §config-embedding-route: every mode forwards ONE public OpenAI-compatible embedding
# route (a built-in daemon profile — no facts) and allowlists its host. The container can't
# reach a loopback embedder, and the corpus must not embed on the task's CPU allotment.
[ -n "${PLURNK_BENCH_EMBEDDING_ROUTE:-}" ] && [ -n "${PLURNK_BENCH_EMBEDDING_BASE_URL:-}" ] || {
  echo "smoke: PLURNK_BENCH_EMBEDDING_ROUTE and PLURNK_BENCH_EMBEDDING_BASE_URL are required" >&2; exit 1
}
EMBED_PREFIX="$(printf '%s' "${PLURNK_BENCH_EMBEDDING_ROUTE%%/*}" | tr -c 'A-Za-z0-9' '_' | tr 'a-z' 'A-Z')"
EMBED_HOST="${PLURNK_BENCH_EMBEDDING_BASE_URL#*://}"; EMBED_HOST="${EMBED_HOST%%[:/]*}"
flags+=(--agent-env "PLURNK_EMBEDDING_MODEL=$PLURNK_BENCH_EMBEDDING_ROUTE")
flags+=(--agent-env "PLURNK_PROVIDERS_PROVIDER_${EMBED_PREFIX}_NPM=@ai-sdk/openai-compatible")
flags+=(--agent-env "PLURNK_PROVIDERS_PROVIDER_${EMBED_PREFIX}_BASE_URL=$PLURNK_BENCH_EMBEDDING_BASE_URL")
EGRESS_DOMAINS="${EGRESS_DOMAINS:+$EGRESS_DOMAINS,}$EMBED_HOST"

# SPEC §config-tavily-route: Tavily is ordinary optional provider configuration. Carry
# it when configured, retain the no-key default, and record only presence + effective depth.
# The official corpus runs web-free: force the route absent in `all` mode.
[ "$TASK" = all ] && TAVILY_API_KEY=""
TAVILY_CONFIGURED=0
[ -n "${TAVILY_API_KEY:-}" ] && TAVILY_CONFIGURED=1
TAVILY_DEPTH="${PLURNK_SCHEMES_HTTP_TAVILY_DEPTH:-basic}"
case "$TAVILY_DEPTH" in
  basic|advanced) ;;
  *) echo "smoke: PLURNK_SCHEMES_HTTP_TAVILY_DEPTH must be basic or advanced" >&2; exit 1;;
esac
TAVILY_ROUTE=absent
[ "$TAVILY_CONFIGURED" = 1 ] && TAVILY_ROUTE="configured:$TAVILY_DEPTH"
# A configured tavily route is deliberate web egress: allowlist its API host too.
[ "$TAVILY_CONFIGURED" = 1 ] && EGRESS_DOMAINS="${EGRESS_DOMAINS:+$EGRESS_DOMAINS,}api.tavily.com"

# CPUs (SPEC §config-native-cpus): default to the task's native allotment (leaderboard-compliant — an --override-cpus
# disqualifies submissions). We used to force host cores to stop the embedder thrashing its
# WASM pool, but the embedder reforms (lazy on ~query #316, binary-free corpus #320) shrank
# the load enough that the native allotment copes. Opt into an override with PLURNK_BENCH_CPUS
# (e.g. on a tiny box, or a task that indexes a huge repo).
cpu_flags=()
[ -n "${PLURNK_BENCH_CPUS:-}" ] && cpu_flags+=(--override-cpus "$PLURNK_BENCH_CPUS")

# Resolve immutable versions before Pier constructs the agent image. The exact install
# command becomes part of Pier's build fingerprint, so a new publication rebuilds and an
# unchanged publication cache-hits. Registry failure is not permission to run an unknown
# cached daemon.
SERVICE_VERSION="$(npm view @plurnk/plurnk-service version 2>/dev/null)"
CLIENT_VERSION="$(npm view @plurnk/plurnk version 2>/dev/null)"
[ -n "$SERVICE_VERSION" ] && [ -n "$CLIENT_VERSION" ] || {
  echo "smoke: cannot resolve current @plurnk publications" >&2
  exit 1
}

# SPEC §config-digest-preflight: the publisher's digest reads the databases the in-container
# daemons write, so the bench's installed @plurnk/plurnk-service must be the version the corpus
# installs — a mismatch is a refused launch, not a crashed publisher mid-run.
DIGEST_VERSION="$(node -e 'console.log(require("@plurnk/plurnk-service/package.json").version)')"
[ "$DIGEST_VERSION" = "$SERVICE_VERSION" ] || {
  echo "smoke: bench digest is @plurnk/plurnk-service $DIGEST_VERSION but the corpus installs $SERVICE_VERSION — npm update @plurnk/plurnk-service, commit, rerun" >&2
  exit 1
}

# SPEC §config-image-prepull: every task image is local before any trial starts — pulled with
# retries and bounded parallelism outside the run, so N-wide launches never stampede the registry
# and no trial dies at environment setup or spends its build timeout downloading.
deepswe/prepull.sh "$TASK"

# Reserve force-build for non-versioned image inputs: exact package publications already
# invalidate the build cache automatically.
build=()
[ -n "${PLURNK_BENCH_FORCE_BUILD:-}" ] && build+=(--force-build)

# Task selection: one named task, or the whole corpus at bounded concurrency.
select_flags=(-i "$TASK" --n-tasks 1)
[ "$TASK" = all ] && select_flags=(--n-concurrent "${PLURNK_BENCH_JOBS:-4}")

echo "smoke: model=$MODEL task=$TASK service=$SERVICE_VERSION client=$CLIENT_VERSION tavily=$TAVILY_ROUTE embed=$PLURNK_BENCH_EMBEDDING_ROUTE egress=$EGRESS_DOMAINS cpus=${PLURNK_BENCH_CPUS:-native} client_timeout=${CLIENT_TIMEOUT_SEC}s (budget ${AGENT_BUDGET:-?}s)${PLURNK_BENCH_FORCE_BUILD:+ [force-build]}" >&2
# The default personality ships on: the daemon seeds PLURNK_PERSONALITY.md to
# the XDG policy file and foists it headless (confirmed via digest, PLURNK_POLICY unset).
# So we DON'T set PLURNK_POLICY — the benchmark gets the real product default as-is.
# SPEC §results-canon: Pier's job scratch and the published runs share ONE tree.
JOBS_ROOT="$(node src/publish.ts --jobs deepswe)"
mkdir -p "$JOBS_ROOT"
before="$(ls -d "$JOBS_ROOT"/*/ 2>/dev/null | sort || true)"
PYTHONPATH=deepswe pier run -p .cache/deep-swe/tasks \
  --agent-import-path driver:PlurnkAgent \
  --model "plurnk/$MODEL" \
  --agent-kwarg "client_timeout_sec=$CLIENT_TIMEOUT_SEC" \
  --agent-kwarg "service_version=$SERVICE_VERSION" \
  --agent-kwarg "client_version=$CLIENT_VERSION" \
  --agent-kwarg "egress_domains=$EGRESS_DOMAINS" \
  --agent-kwarg "tavily_configured=$TAVILY_CONFIGURED" \
  --agent-kwarg "tavily_depth=$TAVILY_DEPTH" \
  "${cpu_flags[@]}" \
  "${build[@]}" \
  "${flags[@]}" \
  "${select_flags[@]}" -o "$JOBS_ROOT" --env docker &
PIER_PID=$!
PUB_PID=""
# SPEC §config-publisher-decoupled: whatever ends this launcher — a signal, a failed step — pier,
# the publisher, and the sampler end with it; nothing runs orphaned.
trap 'kill "$PIER_PID" $PUB_PID 2>/dev/null || true' EXIT INT TERM
JOB=""
for _ in $(seq 1 120); do
  JOB="$(comm -13 <(printf '%s\n' "$before") <(ls -d "$JOBS_ROOT"/*/ 2>/dev/null | sort) | head -1)"
  [ -n "$JOB" ] && break
  sleep 1
done
[ -n "$JOB" ] || { echo "smoke: pier opened no job directory under $JOBS_ROOT" >&2; kill "$PIER_PID" 2>/dev/null || true; exit 1; }

# SPEC §config-resource-samples: once a minute, every container's CPU and memory for the run's
# duration, into the job directory — concurrency is sized from this record, not from estimates.
# The loop ends itself when pier is gone.
(
  while kill -0 "$PIER_PID" 2>/dev/null; do
    now="$(date -u +%FT%TZ)"
    docker stats --no-stream --format '{{json .}}' 2>/dev/null | sed "s/^{/{\"t\":\"$now\",/" >> "$JOB/docker-stats.jsonl"
    sleep 60
  done
) &

# SPEC §publish-live: publish every trial (record + digest) the moment it finishes — single
# task or the whole corpus — so a run can be followed by name while it is still going. With
# PLURNK_BENCH_REQUIEM=1 publish also banks the requiem (the model's exit interview), which
# RE-INVOKES the model — so the publisher runs under the full authoritative provider config
# (shipped defaults floor < XDG user config < this run's model), in a subshell so those
# defaults never leak back into the --agent-env forwarding already sent above.
(
  # The 1.0 floor is READER-DECLARES: every installed member ships its own .env.defaults
  # and the platform assembles them into ONE floor (bench#2). Source them ALL — a knob now
  # lives with its owner (e.g. PLURNK_PROVIDERS_FETCH_TIMEOUT in @plurnk/plurnk-providers).
  for f in node_modules/@plurnk/*/.env.defaults; do [ -f "$f" ] && source_env_file "$f"; done
  source_env_file "$OPERATOR_ENV"
  export PLURNK_MODEL="$MODEL"
  PLURNK_BENCH_HARNESS=deepswe node src/publish.ts --watch "$JOB" --pid "$PIER_PID" \
    || echo "smoke: live publisher exited nonzero — the final pass below publishes whatever it missed" >&2
) &
PUB_PID=$!
# SPEC §config-publisher-decoupled: the publisher never owns pier's lifetime. Wait for pier, then
# one idempotent final pass publishes every trial the live watch did not (already-published
# trials skip by their marker).
pier_status=0
wait "$PIER_PID" || pier_status=$?
wait "$PUB_PID" 2>/dev/null || true
(
  for f in node_modules/@plurnk/*/.env.defaults; do [ -f "$f" ] && source_env_file "$f"; done
  source_env_file "$OPERATOR_ENV"
  export PLURNK_MODEL="$MODEL"
  PLURNK_BENCH_HARNESS=deepswe node src/publish.ts "$JOB"
)
# SPEC §config-failed-setup-report: trials that never reached a model turn because their
# environment failed to start are named in <job>/failed-setup.txt — a rerun list, not a mystery.
find "$JOB" -mindepth 2 -maxdepth 2 -name exception.txt -size +0 2>/dev/null \
  | sed -E 's#.*/([^/]+)__[A-Za-z0-9]+/exception.txt#\1#' | sort -u > "$JOB/failed-setup.txt" || true
failed_setup="$(wc -l < "$JOB/failed-setup.txt" | tr -d ' ')"
[ "$failed_setup" = 0 ] || echo "smoke: $failed_setup trial(s) failed at environment setup — see $JOB/failed-setup.txt (rerun each with deepswe/smoke.sh <task>)" >&2
[ "$pier_status" = 0 ] || { echo "smoke: pier exited nonzero ($pier_status) for $JOB" >&2; exit 1; }
