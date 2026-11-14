#!/usr/bin/env bash
# {§pair-sheet} — the same operator-shell re-exec as benchlet.sh, so both sides see the provider
# keys the interactive shell exports; the benchlet then runs without repeating the dance.
set -euo pipefail

if [ -S /var/run/docker.sock ] && [ ! -w /var/run/docker.sock ] && [ "${PLURNK_BENCHLET_DOCKER_READY:-0}" != "1" ]; then
    export PLURNK_BENCHLET_DOCKER_READY=1
    printf -v quoted '%q ' "$0" "$@"
    exec sg docker -c "exec $quoted"
fi

if [ "${PLURNK_BENCHLET_SHELL_READY:-0}" != "1" ]; then
    operator_rc="${PLURNK_BENCHLET_SHELL_RC:-${HOME}/.bashrc}"
    if [ -f "$operator_rc" ]; then
        export PLURNK_BENCHLET_SHELL_READY=1
        exec bash --noprofile --rcfile "$operator_rc" -i -c 'exec "$@"' bash "$0" "$@"
    fi
fi

exec node --conditions=plurnk-dev "$(dirname "$0")/pair.ts" "$@"
