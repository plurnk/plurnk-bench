#!/usr/bin/env bash
set -euo pipefail

# bughunt runner (SPEC §bughunt). Re-execs under the operator's rc so provider
# credentials/endpoints from ~/.bashrc are present.
if [ "${PLURNK_BUGHUNT_SHELL_READY:-0}" != "1" ]; then
    operator_rc="${PLURNK_BUGHUNT_SHELL_RC:-${HOME}/.bashrc}"
    if [ -f "$operator_rc" ]; then
        export PLURNK_BUGHUNT_SHELL_READY=1
        exec bash --noprofile --rcfile "$operator_rc" -i -c 'exec "$@"' bash "$0" "$@"
    fi
fi

exec node "$(dirname "$0")/run.ts" "$@"
