#!/usr/bin/env bash
# Terminal-Bench family runner (#13/#16): the one launch shape.
#   terminal_bench/run.sh -p .cache/terminal-bench/tasks/<task> -m <alias> [harbor args...]
#   terminal_bench/run.sh -d terminal-bench/terminal-bench@4.0.0 -m <alias> [harbor args...]
# The plurnk agent resolves the model layer from the operator XDG config itself;
# nothing here to remember beyond the alias.
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHONPATH="${PYTHONPATH:+$PYTHONPATH:}." exec harbor run --agent terminal_bench.plurnk_agent:PlurnkAgent "$@"
