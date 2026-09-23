#!/usr/bin/env bash
# {§swebench-profiles} — one corpus through swebench/run.sh, N attempts per instance, bounded
# concurrency, one campaign directory that names every trial it launched. The runner owns each
# trial (unique evaluation run id, provenance, publish); this loop owns only the fan-out and the
# record of what was launched, then reads the sheet with swebench/report.ts.
# Usage: swebench/campaign.sh --corpus <label> [--model <alias>] [--attempts N] [--jobs N] [--limit N] [--only id,id] [--preflight]
set -euo pipefail
bench_root="$(cd "$(dirname "$0")/.." && pwd)"
corpus=""; attempts=1; jobs="${PLURNK_BENCH_JOBS:-4}"; model="${PLURNK_MODEL:-}"; limit=0; only=""; preflight=0
while [ $# -gt 0 ]; do
    case "$1" in
        --corpus) corpus="$2"; shift 2 ;;
        --model) model="$2"; shift 2 ;;
        --attempts) attempts="$2"; shift 2 ;;
        --jobs) jobs="$2"; shift 2 ;;
        --limit) limit="$2"; shift 2 ;;
        --only) only="$2"; shift 2 ;;
        --preflight) preflight=1; shift ;;
        *) echo "campaign: unknown argument $1" >&2; exit 2 ;;
    esac
done
[ -n "$corpus" ] || { echo "usage: swebench/campaign.sh --corpus <label> [--model <alias>] [--attempts N] [--jobs N] [--limit N] [--preflight]" >&2; exit 2; }
corpus_file="$bench_root/swebench/corpora/$corpus.json"
[ -f "$corpus_file" ] || { echo "campaign: no corpus at $corpus_file" >&2; exit 2; }
if [ "$preflight" = 0 ] && [ -z "$model" ]; then echo "campaign: --model <alias> or PLURNK_MODEL is required for a model run" >&2; exit 2; fi
cd "$bench_root"
benchmarks="$(node --input-type=module -e 'import { benchmarksHome } from "./src/host-paths.ts"; console.log(benchmarksHome())')"
mapfile -t ids < <(node -e '
const corpus = require(process.argv[1]); const limit = Number(process.argv[2]); const only = new Set(process.argv[3].split(",").filter(Boolean));
const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
const ids = strings(corpus) ? corpus : [corpus.ids, corpus.instances, corpus.tasks, ...Object.values(corpus)].find(strings);
if (!Array.isArray(ids) || ids.length === 0) throw new Error("corpus carries no ids");
const chosen = only.size > 0 ? ids.filter((id) => only.has(id)) : ids;
for (const id of limit > 0 ? chosen.slice(0, limit) : chosen) console.log(id);
' "$corpus_file" "$limit" "$only")
[ "${#ids[@]}" -gt 0 ] || { echo "campaign: no instances selected from $corpus_file" >&2; exit 2; }
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
campaign="$benchmarks/jobs/swebench-campaigns/${corpus}-${model:-preflight}-${stamp}"
mkdir -p "$campaign/logs"
# the same resolution swebench/run.ts applies: absolute, or relative to the bench root
resolve_root() { node -e 'console.log(require("node:path").resolve(process.argv[1], process.argv[2]))' "$bench_root" "$1"; }
service_root="$(resolve_root "${PLURNK_SWEBENCH_SERVICE_ROOT:-../plurnk-service}")"
client_root="$(resolve_root "${PLURNK_SWEBENCH_CLIENT_ROOT:-../plurnk}")"
[ -d "$service_root" ] && [ -d "$client_root" ] || { echo "campaign: service or client root missing: $service_root, $client_root" >&2; exit 2; }
node -e '
const [file, corpus, model, attempts, jobs, limit, preflight, serviceRoot, clientRoot, ...ids] = process.argv.slice(1);
const { execFileSync } = require("node:child_process");
const head = (dir) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
require("node:fs").writeFileSync(file, JSON.stringify({
    schemaVersion: 1, harness: "swebench", corpus, model: model || null, attempts: Number(attempts), jobs: Number(jobs), limit: Number(limit),
    preflight: preflight === "1", startedAt: new Date().toISOString(), serviceRoot, serviceHead: head(serviceRoot), clientRoot, clientHead: head(clientRoot), ids,
}, null, 2) + "\n");
' "$campaign/campaign.json" "$corpus" "$model" "$attempts" "$jobs" "$limit" "$preflight" "$service_root" "$client_root" "${ids[@]}"
: > "$campaign/trials.tsv"
export CAMPAIGN_DIR="$campaign" CAMPAIGN_MODEL="$model" CAMPAIGN_PREFLIGHT="$preflight" BENCH_ROOT="$bench_root"
run_one() {
    local id="$1" attempt="$2" log rc trial published
    log="$CAMPAIGN_DIR/logs/${id}-a${attempt}.log"
    local args=(--instance "$id")
    [ -n "$CAMPAIGN_MODEL" ] && args+=(--model "$CAMPAIGN_MODEL")
    [ "$CAMPAIGN_PREFLIGHT" = 1 ] && args+=(--preflight)
    rc=0
    "$BENCH_ROOT/swebench/run.sh" "${args[@]}" > "$log" 2>&1 || rc=$?
    trial="$(grep -oE '^(artifact|ready)=\S+' "$log" | tail -1 | cut -d= -f2- || true)"
    published="$(grep -oE '^published=\S+' "$log" | tail -1 | cut -d= -f2- || true)"
    printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$attempt" "$rc" "${trial:-}" "${published:-}" >> "$CAMPAIGN_DIR/trials.tsv"
    echo "campaign: $id attempt $attempt rc=$rc ${trial:+trial=$trial}" >&2
}
export -f run_one
# Every lane shares one frozen checkout and candidate.mjs builds per trial: concurrent
# `build:clean` steps wipe each other's dist. Build both lanes once here; the lanes skip it.
if [ "$preflight" = 0 ]; then
    echo "campaign: building $service_root and $client_root once" >&2
    (cd "$service_root" && npm run -s build > "$campaign/logs/build-service.log" 2>&1) || { echo "campaign: service build failed, see $campaign/logs/build-service.log" >&2; exit 1; }
    (cd "$client_root" && npm run -s build > "$campaign/logs/build-client.log" 2>&1) || { echo "campaign: client build failed, see $campaign/logs/build-client.log" >&2; exit 1; }
    export PLURNK_CANDIDATE_SKIP_BUILD=1
fi
echo "campaign: $campaign (${#ids[@]} instances × $attempts attempts, $jobs lanes, model=${model:-preflight}, service=$(git -C "$service_root" rev-parse --short HEAD), client=$(git -C "$client_root" rev-parse --short HEAD))" >&2
for attempt in $(seq 1 "$attempts"); do for id in "${ids[@]}"; do printf '%s %s\n' "$id" "$attempt"; done; done \
    | xargs -P "$jobs" -n 2 bash -c 'run_one "$@"' _
node "$bench_root/swebench/report.ts" "$campaign" > "$campaign/REPORT.md"
echo "campaign: sheet at $campaign/REPORT.md" >&2
echo "$campaign"
