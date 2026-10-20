# Bug Hunt Bench (`bughunt/`)

Evaluation harness for Pawel Huryn's **Bug Hunt Bench** (`phuryn/bug-hunt-bench`, [bughunt.productcompass.pm](https://bughunt.productcompass.pm)).

Bug Hunt Bench evaluates frontier coding models and agentic CLIs against **105 real-world bugs** planted across two production TypeScript repositories.

## Overview

Unlike SWE-bench, which provides a specific issue report with reproduction steps, Bug Hunt Bench places the agent in a repository with **zero hints** and asks it to audit, discover, and fix as many planted bugs as possible while keeping all existing tests passing and the build clean.

| Target | Codebase | Planted Bugs | Prompt Requirements |
|---|---|---|---|
| **Repo 1** | VS Code / Cursor ACP extension for Grok CLI (~28k LOC) | 45 | Clean `npx tsc -p . --noEmit` and passing `npm test`; write `BUGS_FOUND.md` |
| **Repo 2** | Vite / React / Supabase LMS (~60k LOC) | 60 | Passing `npm test` and clean `npm run build`; write `BUGS_FOUND.md` |
| **Combined** | Both repositories | 105 | Blind-graded against withheld answer keys |

## Target Model & Tokenomics: `deepdumb` (`deepseek/deepseek-flash`)

DeepSeek Flash is the primary release target for Plurnk on Bug Hunt Bench:

- **Economics**: **$0.46–$1.28** per full two-repo run (at current DeepSeek API pricing).
- **Benchmark Performance**: Scores **34–42 / 105** (on par with Opus 5.5 and GPT-6 Astra, and ~100x cheaper than Sonnet 5.5 max).
- **Harness Discipline**: Plurnk's context management and curation verbs prevent context explosion across large codebases without unbounded reasoning overhead.

Model alias configuration in `$XDG_CONFIG_HOME/plurnk/.env`:
```sh
PLURNK_MODEL_deepdumb=deepseek/deepseek-flash
PLURNK_PROVIDERS_EFFORT_deepdumb=low
```

## Running the Benchmark

### 1. Preflight Check
Verify prompts, client availability, and configuration without running the model:
```bash
bughunt/run.sh --preflight
```

### 2. Single Repository Run
```bash
# Repo 1 (VS Code extension)
bughunt/run.sh --task repo1 --repo1 /path/to/repo1 --model deepdumb

# Repo 2 (React/Supabase LMS)
bughunt/run.sh --task repo2 --repo2 /path/to/repo2 --model deepdumb
```

### 3. Full Benchmark (Both Repositories)
```bash
bughunt/run.sh --task all \
  --repo1 /path/to/repo1 \
  --repo2 /path/to/repo2 \
  --model deepdumb
```

### Options
- `--task <repo1|repo2|all>`: Which leg to execute (default: `all`).
- `--repo1 <dir>`: Path to Repo 1 seeded checkout (or `PLURNK_BUGHUNT_REPO1`).
- `--repo2 <dir>`: Path to Repo 2 seeded checkout (or `PLURNK_BUGHUNT_REPO2`).
- `--model <alias>`: Plurnk model alias (default: active model from config cascade).
- `--effort <low|default|high|max>`: Reasoning effort override.
- `--turn-cap <n>`: Maximum agent loop turns (default: 1000).
- `--timeout <s>`: Timeout in seconds (default: -1 for unlimited).
- `--score-json <path>`: Pre-graded score JSON to ingest into the verifier record.
- `--skip-grading`: Skip automated repo health checks and score ingestion.
- `--no-publish`: Retain trial in `jobs/bughunt/` without publishing to `~/benchmarks/`.

## Published Evidence & Canon

Trials publish automatically to the canon (`~/benchmarks/`):
```
~/benchmarks/run<N>-bughunt-<task>-<model>/
  ├── plurnk.db           # Consolidated daemon SQLite database
  ├── digest/             # Forensic report (turns, tools, tokens, friction)
  ├── record.json         # Joined BenchRecord (status, outcome, reward, turns, duration)
  ├── artifacts/
  │   ├── model.patch     # Git diff against start commit
  │   └── BUGS_FOUND.md   # Model's audit findings report
  └── verifier/
      ├── reward.json     # RewardJson (f2p_passed, f2p_total, partial, p2p_passed)
      └── evaluation.json # Detailed scoring breakdown
```

## Submitting to Pawel Huryn's Leaderboard

Pawel Huryn maintains the official leaderboard at `bughunt.productcompass.pm` and executes evaluations or accepts submissions at `https://github.com/phuryn/bug-hunt-bench/issues`.

To submit Plurnk on `deepdumb`:
1. Submit an issue proposing Plurnk as a new agentic CLI harness.
2. Provide the exact command line:
   ```bash
   plurnk --json --yolo --max-turns 1000 --project-root <repo> -- <prompt>
   ```
3. Attach the published trial artifacts (`model.patch`, `BUGS_FOUND.md`, and `digest/` summary) as reference evidence.
