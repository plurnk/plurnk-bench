#!/usr/bin/env bash
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

exec node --conditions=plurnk-dev "$(dirname "$0")/benchlet.ts" "$@"
