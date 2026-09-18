#!/usr/bin/env bash
set -euo pipefail

# swebench runner (SPEC §swebench). Re-execs under the operator's rc so provider
# credentials/endpoints from ~/.bashrc are present, exactly as deepswe/benchlet.sh.
if [ "${PLURNK_SWEBENCH_SHELL_READY:-0}" != "1" ]; then
    operator_rc="${PLURNK_SWEBENCH_SHELL_RC:-${HOME}/.bashrc}"
    if [ -f "$operator_rc" ]; then
        export PLURNK_SWEBENCH_SHELL_READY=1
        exec bash --noprofile --rcfile "$operator_rc" -i -c 'exec "$@"' bash "$0" "$@"
    fi
fi

# The shared core resolves @plurnk/plurnk-service through its published (dist) exports.
exec node "$(dirname "$0")/run.ts" "$@"
