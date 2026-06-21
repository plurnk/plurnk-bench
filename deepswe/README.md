# deepswe

First benchmarking harness for plurnk-bench. One folder per harness; this is DeepSWE.

A harness adapts a specific benchmark's task format to the shared bench core (`../src`):

1. **Load** the benchmark's task set (issue + repo + oracle).
2. **Drive** each task through `@plurnk/plurnk` as a plurnk agent run (the `Runner` seam).
3. **Score** the result with the benchmark's own oracle → an `outcome` on the `BenchRecord`.
4. **Store / summarize / report** via the shared core.

Not yet implemented — scaffold only. The `Runner` seam (objective 1) is blocked on
`@plurnk/plurnk` exposing a programmatic entry; see the root `AGENTS.md` TODO.
