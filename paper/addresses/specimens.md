# Capped specimens, 2026-10-12 (lanes: service 42058d04d, client 28040f6; alias deepdumb = DeepSeek Flash, low)

Partition for every specimen: input room 16,384 provider tokens, output allowance 65,536, wall at room + 4,096.
Plurnk env: PLURNK_PROVIDERS_CONTEXT_WINDOW=81920 OUTPUT_BUDGET=65536 OUTPUT_FLOOR=61440 (+ from specimen 3:
PLURNK_SERVICE_PREVIEW_LINES=10 PREVIEW_CHARS=1600, Matt 2026-10-12: "100 is pathological at this scale").
Pi profile: ~/benchmarks/pi-room16k-20261012/pi-profile.json (catalog window 81,920, maxTokens 65,536,
compaction reserve 65,536 keepRecent 8,192 → compacts when context > 16,384).
Read with: node analysis/specimen.mjs <run-dir>.

## 1. matplotlib-25433, Plurnk, run918 — PASS (f2p 1/1, p2p 55/55), 31 calls, $0.024
Uncapped: 52/53/89 calls, ~$0.062 each. Budget 25,219 units (factor 0.65). Pressure packets 10; over budget once
(102%, T9). Model: pressure at 82% (T6) ignored for 2 turns; READ 413 receipt at 93% (42 of 106 lines delivered);
T8 three KILLs `log:///1/3/3/*/READ` (5 segments) → 204 matched:0, silent; T9 mandate → NOTE + 6 correct KILLs
(compliant); T10 bulk `KILL log:///1/[1-8]/*/{READ,emission,FIND}` → 22%; then re-read 4 ranges it had killed
(eviction without distillation). Later pressures (T21, T26-27) answered within a turn by KILL with a body.
Friction: 3 × 400 at T26-28 — `COPY (sh://python verify_fix.py) (out.txt)` and a COPY with a body: the model
wanted command output out of context; the card teaches no page/receipt at all (grep: nothing). WAIT with nothing
in flight (102). Over-budget row persists as history (log:///1/9/1/error) in 22 later packets; model KILLed it.
Digest: DEGENERATE-WIN (6 "errors" = 3 parse + 1 mandate + 2 receipts).

## 2. pytest-5103, Plurnk, run919 — PASS (f2p 1/1, p2p 64/64), 66 calls over 2 workers, $0.073
Uncapped: 41/44/47 calls, ~$0.102 each. Parent 29 calls ($0.047), child worker `fixAllAny` 37 calls.
Parent: pressure at 90% (T7) → NOTE; T8 5 KILLs with one distillation body → 38%; pressure T16-19 → T19 KILL batch
→ 45%; T22 at 86%: WORK child with a full brief (task, key code locations) + WAIT 202 — delegation as curation;
T23 109% mandate → KILL bulk + NOTE (compliant); T24-30 sh verification, SEND.
Child: T7 104% mandate: 3 KILLs `log:///1/2/5 /*/{READ,FIND,emission}` (space → parsed as a pattern) → 400
"Unreadable pattern"; T8 114%: `KILL log:///1/*/READ` and `/FIND` (3 segments) → 204 matched:0; T9 115%: 7
correct 4-segment KILLs → 200; T10-11 more KILLs → 35%. No shedding (wall ≈ 125%). EDIT `<0,-1>` → 416 twice
(recovery names the 1-based rule), fixed on the third. Preview still 100 lines (started before the change).
Digest: 2 × DEGENERATE-WIN.

## 3. django-11564, Plurnk, run920 — FAIL (f2p 0/2, p2p 174/174), 80 calls, $0.069; first with 10-line pages
Uncapped: ✗✗✗ both arms; Plurnk 67/45/25 calls, ~$0.059 each. Max packet 99%, never over budget; pressure packets
36 of 79; KILL 30 retiring 148 rows, usually within 1-3 turns of a notice, with distillation bodies. 24 of 79
turns NOTE-only (30%). Pull at 10 lines worked: `READ sh:///…#stdout <10,49>` after the first page.
Refused (10): 2 × 413 receipts (contract); journal KILL targets as `|`-joined lists → 400 "malformed" ×3 (T60,
T63, T79) and `[19,24,…]/**` → 204 (T68), `1/[1-2]/[1-9]/*/{…}` 5 segments → 204 (T22); `sh` with metadata
`stream` → 400 "does not accept metadata field" (output-avoidance instinct again); empty `sh` → 400; an aside in a
`sh` header → parse 400; EDIT of an existing file without a line marker → 400 ×2.

## Pi, matplotlib-25433, first run (jobs/swebench-pi/…-m0Qs8A) — PASS, 65 calls, $0.033, cap did NOT bind
Context grew 2.2k → 62.6k monotonically; no compaction. Cause: for a built-in provider Pi takes model metadata from
its own catalog; the pinned store's contextWindow does not override it. Fix landed: bench e2830e3 — profile
`modelOverrides` → models.json `providers.<p>.modelOverrides.<model>` (Pi's documented layer). Re-run pending.

## Pi, matplotlib-25433, re-run with the override (…-WDwFlu) — PASS, 83 calls, $0.121, cap BOUND
15 compactions from call 22 on, every 3-5 calls (keepRecent 8k leaves 6-10k after each; refills fast). Max prompt
20,240 (the check is between turns). Prompt 1.09M (69% cached, vs 98.6% uncapped: each compaction breaks the cache
prefix); output 114.6k of which 22.3k reasoning → ~92k non-reasoning output vs 8.6k uncapped: the summaries.
Side by side at a 16k room, this task, one attempt each: Plurnk 31 calls $0.024 PASS vs Pi 83 calls $0.121 PASS;
uncapped means Plurnk $0.062, Pi $0.021.

## Recurring
- Journal coordinate shape: 3/3 specimens lost 1-3 turns to KILL addresses with the wrong segment count or a
  `|`-joined list; the 204 body was `{"status":204,"matched":0}` with no shape. Landed as service `e7f2a975b`
  (#1094, `|` lists; shape on refusals) and `8b847e71b` (#1095: the three near-miss shapes read as the target
  meant: `1/3/3/*/READ`→`1/3/3/READ`, `1/*/READ`→`1/*/*/READ`, `[19,24]`→`{19,24}`; the sweep's 204 bare again,
  Matt 2026-10-12: no more metadata on the uncached tail). The card is unchanged (Matt: no card line for every
  mistake).
- Mandate obeyed both times; pressure notice answered within 0-2 turns; the over-budget row outlives its turn.
- Both passed, both cheaper than their uncapped attempts (n = 2; not a result).
