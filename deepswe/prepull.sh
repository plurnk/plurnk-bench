#!/usr/bin/env bash
# Pre-download the DeepSWE task images independently of any run (SPEC §config-image-prepull).
# A run then starts every trial from a local image: no ECR stampede at N-wide, no environment-
# setup failures, no build timeout spent downloading. Bounded parallelism, retries with backoff,
# a disk floor, and a loud list of anything unresolvable.
#
# Usage: deepswe/prepull.sh [task-glob|all]     (default: all)
#   PLURNK_BENCH_PREPULL_JOBS      concurrent pulls (default 3 — public ECR throttles wider fan-out)
#   PLURNK_BENCH_PREPULL_ATTEMPTS  attempts per image (default 3, backoff 5s/20s/60s)
#   PLURNK_BENCH_PREPULL_DISK_FLOOR_GB  stop pulling when the docker volume has less free (default 40)
set -euo pipefail
cd "$(dirname "$0")/.."
TASK="${1:-all}"
JOBS="${PLURNK_BENCH_PREPULL_JOBS:-3}"
ATTEMPTS="${PLURNK_BENCH_PREPULL_ATTEMPTS:-3}"
FLOOR_GB="${PLURNK_BENCH_PREPULL_DISK_FLOOR_GB:-40}"
TASKS=.cache/deep-swe/tasks
[ -d "$TASKS" ] || { echo "prepull: no task corpus at $TASKS" >&2; exit 1; }

images=()
for dir in "$TASKS"/*/; do
  id="$(basename "$dir")"
  if [ "$TASK" != all ]; then case "$id" in $TASK) ;; *) continue;; esac; fi
  img="$(sed -n -E 's/^docker_image *= *"([^"]+)".*/\1/p' "$dir/task.toml" | head -1)"
  [ -n "$img" ] || { echo "prepull: $id declares no docker_image in task.toml" >&2; exit 1; }
  images+=("$img")
done
[ "${#images[@]}" -gt 0 ] || { echo "prepull: no task matches '$TASK'" >&2; exit 1; }
mapfile -t images < <(printf '%s\n' "${images[@]}" | sort -u)

present=0; missing=()
for img in "${images[@]}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then present=$((present+1)); else missing+=("$img"); fi
done
docker_free_gb() { df -BG --output=avail "$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)" | tail -1 | tr -dc '0-9'; }
echo "prepull: ${#images[@]} images for '$TASK' — $present present, ${#missing[@]} to pull; docker volume free $(docker_free_gb)G (floor ${FLOOR_GB}G)"
[ "${#missing[@]}" -eq 0 ] && exit 0

pull_one() {
  img="$1"
  for attempt in $(seq 1 "$ATTEMPTS"); do
    free="$(docker_free_gb)"
    if [ "$free" -lt "$FLOOR_GB" ]; then echo "FLOOR $img (free ${free}G < ${FLOOR_GB}G)"; return 3; fi
    if docker pull -q "$img" >/dev/null 2>&1; then echo "OK $img"; return 0; fi
    case "$attempt" in 1) sleep 5;; 2) sleep 20;; *) sleep 60;; esac
  done
  echo "FAIL $img"; return 1
}
export -f pull_one docker_free_gb
export ATTEMPTS FLOOR_GB
results="$(printf '%s\n' "${missing[@]}" | xargs -P "$JOBS" -I{} bash -c 'pull_one "$@"' _ {} || true)"
printf '%s\n' "$results"
ok="$(printf '%s\n' "$results" | grep -c '^OK ' || true)"
failed="$(printf '%s\n' "$results" | grep -E '^(FAIL|FLOOR) ' || true)"
echo "prepull: pulled $ok of ${#missing[@]}; docker volume free $(docker_free_gb)G"
if [ -n "$failed" ]; then
  echo "prepull: unresolved images — a run must not start trials without them:" >&2
  printf '%s\n' "$failed" >&2
  exit 1
fi
