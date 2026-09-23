#!/usr/bin/env bash
# {§swebench-profiles} — one corpus through swebench/run.sh, one trial at a time by default, one
# campaign directory that names every trial it launched. The runner owns each trial (unique
# evaluation run id, provenance, publish); this loop owns the order (swebench/plan.ts), the record
# of what ran (trials.tsv) and the halt: the first trial that is not a clean pass — oracle resolved
# and the client exited 0 — stops the loop, so it is read before the next trial is paid for.
# --resume continues a halted campaign past its clean passes and any --skip ids, which it remembers
# in <campaign>/accepted so no later launch re-buys a read failure; the sheet is swebench/report.ts.
# --halt-on pass (default) halts at anything but a clean pass; --halt-on clean halts only at a trial
# that did not exit cleanly (an agent or harness verdict), letting the oracle's own misses run on.
# Usage: swebench/campaign.sh --corpus <label> [--model <alias>] [--attempts N] [--jobs N] [--limit N] [--only id,id] [--skip id,id] [--halt-on pass|clean] [--preflight]
#        swebench/campaign.sh --resume <campaign-dir> [--jobs N] [--limit N] [--only id,id] [--skip id,id] [--halt-on pass|clean]
set -euo pipefail
# Everything runs inside main() so bash parses the whole file before the fan-out begins: an edit
# to this script while a campaign runs cannot shift what the running shell reads next.
main() {
    bench_root="$(cd "$(dirname "$0")/.." && pwd)"
    corpus=""; attempts=""; jobs="${PLURNK_BENCH_JOBS:-1}"; model="${PLURNK_MODEL:-}"; limit=0; only=""; skip=""; preflight=""; resume=""; halt_on="pass"
    while [ $# -gt 0 ]; do
        case "$1" in
            --corpus) corpus="$2"; shift 2 ;;
            --model) model="$2"; shift 2 ;;
            --attempts) attempts="$2"; shift 2 ;;
            --jobs) jobs="$2"; shift 2 ;;
            --limit) limit="$2"; shift 2 ;;
            --only) only="$2"; shift 2 ;;
            --skip) skip="$2"; shift 2 ;;
            --preflight) preflight=1; shift ;;
            --resume) resume="$2"; shift 2 ;;
            --halt-on) halt_on="$2"; shift 2 ;;
            *) echo "campaign: unknown argument $1" >&2; exit 2 ;;
        esac
    done
    usage="usage: swebench/campaign.sh --corpus <label> [--model <alias>] [--attempts N] [--jobs N] [--limit N] [--only id,id] [--skip id,id] [--halt-on pass|clean] [--preflight] | --resume <campaign-dir> [--jobs N] [--limit N] [--only id,id] [--skip id,id] [--halt-on pass|clean]"
    case "$halt_on" in pass|clean) ;; *) echo "campaign: --halt-on takes pass or clean" >&2; exit 2 ;; esac
    cd "$bench_root"
    launch="$(date -u +%Y%m%dT%H%M%SZ)"
    field() { node -e 'const record = require(process.argv[1]); const value = record[process.argv[2]]; console.log(value === null || value === undefined ? "" : value)' "$1" "$2"; }
    if [ -n "$resume" ]; then
        [ -z "$corpus$attempts$preflight" ] || { echo "campaign: --resume takes corpus, model, attempts and preflight from campaign.json" >&2; exit 2; }
        campaign="$(cd "$resume" && pwd)"
        [ -f "$campaign/campaign.json" ] && [ -f "$campaign/trials.tsv" ] || { echo "campaign: $campaign is not a campaign directory" >&2; exit 2; }
        corpus="$(field "$campaign/campaign.json" corpus)"; model="$(field "$campaign/campaign.json" model)"; attempts="$(field "$campaign/campaign.json" attempts)"
        if [ "$(field "$campaign/campaign.json" preflight)" = "true" ]; then preflight=1; else preflight=0; fi
        trials_flag=(--trials "$campaign/trials.tsv")
    else
        [ -n "$corpus" ] || { echo "$usage" >&2; exit 2; }
        attempts="${attempts:-1}"; preflight="${preflight:-0}"
        trials_flag=()
    fi
    corpus_file="$bench_root/swebench/corpora/$corpus.json"
    [ -f "$corpus_file" ] || { echo "campaign: no corpus at $corpus_file" >&2; exit 2; }
    if [ "$preflight" = 0 ] && [ -z "$model" ]; then echo "campaign: --model <alias> or PLURNK_MODEL is required for a model run" >&2; exit 2; fi
    # a --skip id is a failure read and accepted as the model's: the campaign remembers it
    if [ -n "$resume" ] && [ -n "$skip" ]; then printf '%s\n' ${skip//,/ } >> "$campaign/accepted"; fi
    accepted_flag=(); [ -n "$resume" ] && [ -f "$campaign/accepted" ] && accepted_flag=(--accepted "$campaign/accepted")
    mapfile -t pairs < <(node swebench/plan.ts --corpus "$corpus_file" --attempts "$attempts" --limit "$limit" --only "$only" --skip "$skip" "${trials_flag[@]}" "${accepted_flag[@]}")
    [ "${#pairs[@]}" -gt 0 ] || { echo "campaign: nothing left to run from $corpus_file" >&2; exit 2; }
    # the same resolution swebench/run.ts applies: absolute, or relative to the bench root
    resolve_root() { node -e 'console.log(require("node:path").resolve(process.argv[1], process.argv[2]))' "$bench_root" "$1"; }
    service_root="$(resolve_root "${PLURNK_SWEBENCH_SERVICE_ROOT:-../plurnk-service}")"
    client_root="$(resolve_root "${PLURNK_SWEBENCH_CLIENT_ROOT:-../plurnk}")"
    [ -d "$service_root" ] && [ -d "$client_root" ] || { echo "campaign: service or client root missing: $service_root, $client_root" >&2; exit 2; }
    if [ -z "$resume" ]; then
        benchmarks="$(node --input-type=module -e 'import { benchmarksHome } from "./src/host-paths.ts"; console.log(benchmarksHome())')"
        campaign="$benchmarks/jobs/swebench-campaigns/${corpus}-${model:-preflight}-${launch}"
        mkdir -p "$campaign/logs"
        node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    import { corpusIds } from "./swebench/plan.ts";
    const [file, corpusFile, corpus, model, attempts, jobs, preflight, serviceRoot, clientRoot] = process.argv.slice(1);
    const head = (dir) => execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(file, JSON.stringify({
        schemaVersion: 2, harness: "swebench", corpus, model: model || null, attempts: Number(attempts), jobs: Number(jobs),
        preflight: preflight === "1", startedAt: new Date().toISOString(), serviceRoot, serviceHead: head(serviceRoot), clientRoot, clientHead: head(clientRoot),
        ids: corpusIds(JSON.parse(readFileSync(corpusFile, "utf8"))),
    }, null, 2) + "\n");
    ' "$campaign/campaign.json" "$corpus_file" "$corpus" "$model" "$attempts" "$jobs" "$preflight" "$service_root" "$client_root"
        : > "$campaign/trials.tsv"
    fi
    # every launch, first or resumed, records what it selected beside the campaign record
    node -e '
    const [file, launch, limit, only, skip, jobs, haltOn, ...pairs] = process.argv.slice(1);
    require("node:fs").writeFileSync(file, JSON.stringify({ launch, limit: Number(limit), only, skip, jobs: Number(jobs), haltOn, pairs }, null, 2) + "\n");
    ' "$campaign/launch-$launch.json" "$launch" "$limit" "$only" "$skip" "$jobs" "$halt_on" "${pairs[@]}"
    export CAMPAIGN_DIR="$campaign" CAMPAIGN_MODEL="$model" CAMPAIGN_PREFLIGHT="$preflight" CAMPAIGN_LAUNCH="$launch" CAMPAIGN_HALT_ON="$halt_on" BENCH_ROOT="$bench_root"
    run_one() {
        local id="$1" attempt="$2" log rc trial published verdict
        log="$CAMPAIGN_DIR/logs/${id}-a${attempt}-${CAMPAIGN_LAUNCH}.log"
        local args=(--instance "$id")
        [ -n "$CAMPAIGN_MODEL" ] && args+=(--model "$CAMPAIGN_MODEL")
        [ "$CAMPAIGN_PREFLIGHT" = 1 ] && args+=(--preflight)
        rc=0
        "$BENCH_ROOT/swebench/run.sh" "${args[@]}" > "$log" 2>&1 || rc=$?
        trial="$(grep -oE '^(artifact|ready)=\S+' "$log" | tail -1 | cut -d= -f2- || true)"
        published="$(grep -oE '^published=\S+' "$log" | tail -1 | cut -d= -f2- || true)"
        if [ "$CAMPAIGN_PREFLIGHT" = 1 ]; then
            if [ "$rc" = 0 ]; then verdict=pass; else verdict="harness: rc=$rc"; fi
        elif [ -z "$trial" ]; then
            verdict="harness: rc=$rc, no trial directory"
        else
            verdict="$(node "$BENCH_ROOT/swebench/report.ts" --verdict "$trial")"
        fi
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$attempt" "$rc" "${trial:-}" "${published:-}" "$verdict" >> "$CAMPAIGN_DIR/trials.tsv"
        echo "campaign: $id attempt $attempt rc=$rc verdict=$verdict ${trial:+trial=$trial}" >&2
        # exit 255 is xargs' own stop signal: nothing further is launched
        local halt=0
        case "$CAMPAIGN_HALT_ON" in
            pass) [ "$verdict" = pass ] || halt=1 ;;
            clean) case "$verdict" in agent:*|harness:*) halt=1 ;; esac ;;
        esac
        [ "$halt" = 0 ] || { echo "campaign: halted at $id attempt $attempt — $verdict; see $log" >&2; exit 255; }
    }
    export -f run_one
    # Every lane shares one frozen checkout and candidate.mjs builds per trial: concurrent
    # `build:clean` steps wipe each other's dist. Build both lanes once here; the lanes skip it.
    if [ "$preflight" = 0 ]; then
        echo "campaign: building $service_root and $client_root once" >&2
        (cd "$service_root" && npm run -s build > "$campaign/logs/build-service-$launch.log" 2>&1) || { echo "campaign: service build failed, see $campaign/logs/build-service-$launch.log" >&2; exit 1; }
        (cd "$client_root" && npm run -s build > "$campaign/logs/build-client-$launch.log" 2>&1) || { echo "campaign: client build failed, see $campaign/logs/build-client-$launch.log" >&2; exit 1; }
        export PLURNK_CANDIDATE_SKIP_BUILD=1
    fi
    echo "campaign: $campaign (${#pairs[@]} trials this launch, $jobs lane(s), model=${model:-preflight}, service=$(git -C "$service_root" rev-parse --short HEAD), client=$(git -C "$client_root" rev-parse --short HEAD))" >&2
    halted=0
    printf '%s\n' "${pairs[@]}" | xargs -P "$jobs" -n 2 bash -c 'run_one "$@"' _ || halted=$?
    node "$bench_root/swebench/report.ts" "$campaign" > "$campaign/REPORT.md"
    if [ "$halted" != 0 ]; then
        echo "campaign: halted; read $campaign/REPORT.md, then swebench/campaign.sh --resume $campaign [--skip <id>]" >&2
        exit 3
    fi
    echo "campaign: sheet at $campaign/REPORT.md" >&2
    echo "$campaign"
}
main "$@"
