#!/usr/bin/env bash
# {§bench-relock} — one command to point the frozen lanes at exact service and client commits.
# Usage: deepswe/relock.sh <service-ref> <client-ref> [<lanes-root>]
# The lanes are detached worktrees beside this checkout (../bench-lanes/plurnk-service and
# ../bench-lanes/plurnk), created on first use, moved on later ones, and installed with
# `npm ci` and the selected platform contracts; the benchlet runs those trees, never a checkout being
# edited ({§benchlet-provenance}). Prints the two exports a lane needs.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "usage: deepswe/relock.sh <service-ref> <client-ref> [<lanes-root>]" >&2
    exit 2
fi
service_ref="$1"
client_ref="$2"
bench_root="$(cd "$(dirname "$0")/.." && pwd)"
lanes="${3:-$(cd "$bench_root/.." && pwd)/bench-lanes}"
mkdir -p "$lanes"
lanes="$(cd "$lanes" && pwd)"

relock() {
    local repo="$1" lane="$2" ref="$3"; shift 3
    local sha
    sha="$(git -C "$repo" rev-parse --verify "${ref}^{commit}")"
    if [ -d "$lane/.git" ] || [ -f "$lane/.git" ]; then
        git -C "$lane" checkout --quiet --detach "$sha"
    else
        git -C "$repo" worktree add --quiet --detach "$lane" "$sha"
    fi
    (cd "$lane" && npm ci --no-audit --no-fund "$@" > /dev/null)
    echo "relock: $lane at $(git -C "$lane" rev-parse --short HEAD) ($(git -C "$lane" log -1 --format=%s))" >&2
}

relock "$bench_root/../plurnk-service" "$lanes/plurnk-service" "$service_ref"
relock "$bench_root/../plurnk" "$lanes/plurnk" "$client_ref" --ignore-scripts
node "$bench_root/src/candidate-client.ts" "$lanes/plurnk-service" "$lanes/plurnk"

echo "export PLURNK_BENCHLET_SERVICE_ROOT=$lanes/plurnk-service"
echo "export PLURNK_BENCHLET_CLIENT_ROOT=$lanes/plurnk"
