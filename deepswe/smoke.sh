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

PYTHONPATH=deepswe exec pier run -p .cache/deep-swe/tasks \
  --agent-import-path driver:PlurnkAgent \
  --model "plurnk/$MODEL" \
  "${flags[@]}" \
  -i "$TASK" --n-tasks 1 --env docker
