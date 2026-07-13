#!/usr/bin/env bash
# Diagnostic smoke (SPEC §config-carry): drive one DeepSWE task through plurnk. Reads the AUTHORITATIVE daemon
# config IN PLACE — bench re-declares nothing:
#   • model layer   ← ~/.plurnk/.env   (PLURNK_MODEL_<alias>, PLURNK_PROVIDERS_GBNF)
#   • provider env  ← your shell        (.bashrc: OPENAI_BASE_URL, XAI_*, keys, …)
# and forwards it to the in-container daemon via --agent-env (Pier does NOT interpolate
# ${VAR} in --config — that resolver is dead code). A *_BASE_URL on host loopback is
# rewritten to the host LAN IP, the one container-boundary transform (the container can't
# reach the host's 127.0.0.1, but reaches the same 0.0.0.0-bound server on the LAN).
#
# Usage: deepswe/smoke.sh [task-glob] [model-alias]
#   task-glob    default: abs-module-cache-flags
#   model-alias  default: PLURNK_MODEL from ~/.plurnk/.env  (e.g. turboderp, grok)
# Bench's own knobs are namespaced PLURNK_BENCH_ (SPEC §config-bench-namespace — never forwarded to the daemon):
#   PLURNK_BENCH_TIMEOUT_SEC  override the client timeout (default: task's [agent] budget − headroom)
#   PLURNK_BENCH_CPUS         override container cpus (default: task native — leaderboard-compliant)
#   PLURNK_BENCH_FORCE_BUILD  =1 to force an agent-image rebuild (after a @plurnk version bump)
#   PLURNK_BENCH_NO_GBNF      =1 to drop PLURNK_PROVIDERS_GBNF (for models that can't enforce it, e.g. xai)
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . "$HOME/.plurnk/.env"; set +a   # model layer; provider env already present via .bashrc
# Transport (service 1.0.0): single listener — PLURNK_PORT=3044 is THE client surface
# (AG-UI); the separate WS listener is gone. The in-container daemon+client pair share the
# shipped default, so bench sets NOTHING here (a stale port export silently kills the loop).
TASK="${1:-abs-module-cache-flags}"
MODEL="${2:-${PLURNK_MODEL:?set PLURNK_MODEL in ~/.plurnk/.env or pass a model alias}}"
LAN_IP="$(hostname -I | awk '{print $1}')"

# Give the agent the BENCHMARK's own budget, not an arbitrary cap: read the task's
# [agent] timeout_sec and use it minus headroom (daemon boot + commit + DB copy). A
# shorter client --timeout would starve the model below the benchmark's intended
# allowance and understate every result (SPEC §config-budget). Override with PLURNK_BENCH_TIMEOUT_SEC for quick dev.
TASKDIR="$(ls -d ".cache/deep-swe/tasks/$TASK"*/ 2>/dev/null | head -1)"
AGENT_BUDGET="$(awk -F= '/^\[/{s=$0} s=="[agent]" && $1 ~ /timeout_sec/ {v=$2; gsub(/[^0-9.]/,"",v); printf "%d", v}' "${TASKDIR}task.toml" 2>/dev/null)"
CLIENT_TIMEOUT_SEC="${PLURNK_BENCH_TIMEOUT_SEC:-$(( ${AGENT_BUDGET:-1920} - 120 ))}"

# Forward the DAEMON's config that already exists: every PLURNK_* (alias defs + GBNF) and
# each provider *_BASE_URL / *_API_KEY that is set, rewriting host loopback → LAN for the
# container. Bench's own PLURNK_BENCH_* knobs are orchestration, not daemon config — never
# forward them. No hand-maintained manifest.
flags=(--agent-env "PLURNK_MODEL=$MODEL")
for k in $(compgen -v | grep -E '^PLURNK_|_BASE_URL$|_API_KEY$' | grep -v '^PLURNK_BENCH_'); do
  case "$k" in
    PLURNK_MODEL|PLURNK_MODEL_NAME) continue;;
    # A non-llama backend (xai/openrouter) can't enforce GBNF; 0.70.0's daemon refuses to
    # boot with GBNF requested-but-unenforceable. PLURNK_BENCH_NO_GBNF=1 runs unconstrained.
    PLURNK_PROVIDERS_GBNF) [ -n "${PLURNK_BENCH_NO_GBNF:-}" ] && continue;;
  esac
  v="${!k:-}"; [ -n "$v" ] || continue
  case "$k" in *_BASE_URL) v="${v//127.0.0.1/$LAN_IP}"; v="${v//localhost/$LAN_IP}";; esac
  flags+=(--agent-env "$k=$v")
done
# SPEC §config-gbnf-optout: the container's shipped .env floor DEFAULTS PLURNK_PROVIDERS_GBNF=plurnk.gbnf, so merely
# not forwarding it isn't enough — forward =0 to explicitly override the default OFF.
[ -n "${PLURNK_BENCH_NO_GBNF:-}" ] && flags+=(--agent-env "PLURNK_PROVIDERS_GBNF=0")

# CPUs (SPEC §config-native-cpus): default to the task's native allotment (leaderboard-compliant — an --override-cpus
# disqualifies submissions). We used to force host cores to stop the embedder thrashing its
# WASM pool, but the embedder reforms (lazy on ~query #316, binary-free corpus #320) shrank
# the load enough that the native allotment copes. Opt into an override with PLURNK_BENCH_CPUS
# (e.g. on a tiny box, or a task that indexes a huge repo).
cpu_flags=()
[ -n "${PLURNK_BENCH_CPUS:-}" ] && cpu_flags+=(--override-cpus "$PLURNK_BENCH_CPUS")

# Set PLURNK_BENCH_FORCE_BUILD=1 after a @plurnk version bump: Docker caches the agent-build
# layer (which `npm i -g @plurnk/...@latest`s), so without --force-build a run reuses the old
# daemon version. Skip it otherwise for fast cached builds.
build=()
[ -n "${PLURNK_BENCH_FORCE_BUILD:-}" ] && build+=(--force-build)

echo "smoke: model=$MODEL task=$TASK cpus=${PLURNK_BENCH_CPUS:-native} client_timeout=${CLIENT_TIMEOUT_SEC}s (budget ${AGENT_BUDGET:-?}s)${PLURNK_BENCH_FORCE_BUILD:+ [force-build]}" >&2
# The default personality ships on: the daemon seeds PLURNK_PERSONALITY.md to
# ~/.plurnk/AGENTS.md and foists it headless (confirmed via digest, PLURNK_POLICY unset).
# So we DON'T set PLURNK_POLICY — the benchmark gets the real product default as-is.
PYTHONPATH=deepswe pier run -p .cache/deep-swe/tasks \
  --agent-import-path driver:PlurnkAgent \
  --model "plurnk/$MODEL" \
  --agent-kwarg "client_timeout_sec=$CLIENT_TIMEOUT_SEC" \
  "${cpu_flags[@]}" \
  "${build[@]}" \
  "${flags[@]}" \
  -i "$TASK" --n-tasks 1 --env docker

# Publish the run to the shared benchmarks tree (<plurnk>/benchmarks/run<N>) so it can be
# referenced by name — "check out run<N> with me". Publish also banks the requiem (the model's
# exit interview), which RE-INVOKES the model — so run it under the full authoritative provider
# config (shipped defaults floor < ~/.plurnk/.env < this run's model), in a subshell so those
# defaults never leak back into the --agent-env forwarding already sent above.
(
  set -a
  # the shipped legend: .env.defaults since 1.0.0 (.env.example before)
  for f in node_modules/@plurnk/plurnk-service/.env.defaults node_modules/@plurnk/plurnk-service/.env.example; do
    [ -f "$f" ] && { . "$f"; break; }
  done
  . "$HOME/.plurnk/.env"
  set +a
  export PLURNK_MODEL="$MODEL"
  node src/publish.ts "$(ls -dt jobs/*/ | head -1)"
)
