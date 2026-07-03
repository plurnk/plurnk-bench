#!/usr/bin/env bash
# Diagnostic smoke: drive one DeepSWE task through plurnk. Reads the AUTHORITATIVE daemon
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
set -euo pipefail
cd "$(dirname "$0")/.."

set -a; . "$HOME/.plurnk/.env"; set +a   # model layer; provider env already present via .bashrc
TASK="${1:-abs-module-cache-flags}"
MODEL="${2:-${PLURNK_MODEL:?set PLURNK_MODEL in ~/.plurnk/.env or pass a model alias}}"
LAN_IP="$(hostname -I | awk '{print $1}')"

# Give the agent the BENCHMARK's own budget, not an arbitrary cap: read the task's
# [agent] timeout_sec and use it minus headroom (daemon boot + commit + DB copy). A
# shorter client --timeout would starve the model below the benchmark's intended
# allowance and understate every result. Override with CLIENT_TIMEOUT_SEC for quick dev.
TASKDIR="$(ls -d ".cache/deep-swe/tasks/$TASK"*/ 2>/dev/null | head -1)"
AGENT_BUDGET="$(awk -F= '/^\[/{s=$0} s=="[agent]" && $1 ~ /timeout_sec/ {v=$2; gsub(/[^0-9.]/,"",v); printf "%d", v}' "${TASKDIR}task.toml" 2>/dev/null)"
CLIENT_TIMEOUT_SEC="${CLIENT_TIMEOUT_SEC:-$(( ${AGENT_BUDGET:-1920} - 120 ))}"

# Forward the config that already exists: every PLURNK_* (alias defs + GBNF) and each
# provider *_BASE_URL / *_API_KEY that is set, rewriting host loopback → LAN for the
# container. No hand-maintained manifest.
flags=(--agent-env "PLURNK_MODEL=$MODEL")
for k in $(compgen -v | grep -E '^PLURNK_|_BASE_URL$|_API_KEY$'); do
  case "$k" in PLURNK_MODEL|PLURNK_MODEL_NAME) continue;; esac
  v="${!k:-}"; [ -n "$v" ] || continue
  case "$k" in *_BASE_URL) v="${v//127.0.0.1/$LAN_IP}"; v="${v//localhost/$LAN_IP}";; esac
  flags+=(--agent-env "$k=$v")
done

# Give the container the box's cores — portable across whatever hardware a third party
# runs this on. The embedder sizes its WASM pool to os.availableParallelism()
# (PLURNK_EMBED_WORKERS=-1, the shipped default); a Docker --cpus quota throttles
# time-slice but does NOT shrink the visible core count, so an under-provisioned
# container spawns host-core-many workers thrashing over few cpus (the 28-min stall).
# Matching the container's cpu allotment to that same count keeps workers==cores
# everywhere, no hardcoded value, no thrash. Override with OVERRIDE_CPUS.
CPUS="${OVERRIDE_CPUS:-$(node -e 'process.stdout.write(String(require("os").availableParallelism()))')}"

# Set FORCE_BUILD=1 after a @plurnk version bump: Docker caches the agent-build layer
# (which `npm i -g @plurnk/...@latest`s), so without --force-build a run reuses the old
# daemon version. Skip it otherwise for fast cached builds.
build=()
[ -n "${FORCE_BUILD:-}" ] && build+=(--force-build)

echo "smoke: model=$MODEL task=$TASK cpus=$CPUS client_timeout=${CLIENT_TIMEOUT_SEC}s (budget ${AGENT_BUDGET:-?}s)${FORCE_BUILD:+ [force-build]}" >&2
# The default personality ships on: the daemon seeds PLURNK_PERSONALITY.md to
# ~/.plurnk/AGENTS.md and foists it headless (confirmed via digest, PLURNK_POLICY unset).
# So we DON'T set PLURNK_POLICY — the benchmark gets the real product default as-is.
PYTHONPATH=deepswe pier run -p .cache/deep-swe/tasks \
  --agent-import-path driver:PlurnkAgent \
  --model "plurnk/$MODEL" \
  --agent-kwarg "client_timeout_sec=$CLIENT_TIMEOUT_SEC" \
  --override-cpus "$CPUS" \
  "${build[@]}" \
  "${flags[@]}" \
  -i "$TASK" --n-tasks 1 --env docker

# Publish the run to the shared benchmarks tree (<plurnk>/benchmarks/run<N>) so it can be
# referenced by name — "check out run<N> with me".
node src/publish.ts "$(ls -dt jobs/*/ | head -1)"
