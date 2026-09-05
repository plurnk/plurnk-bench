import { median } from "../src/statistics.ts";
import type { TaskReport } from "./report.ts";

export interface BaselineTrial {
    task_name: string;
    config: string;
    model: string;
    reasoning_effort: string;
    included_in_score: boolean;
    score_value: number;
    n_input_tokens?: number | null;
    n_cache_tokens?: number | null;
    n_output_tokens?: number | null;
    agent_duration_seconds?: number | null;
}

const score = (values: number[]) => ({
    passed: values.filter((value) => value === 1).length,
    attempted: values.length,
    passRate: values.length === 0 ? null : values.filter((value) => value === 1).length / values.length,
});

export const compareBaseline = (rows: TaskReport[], trials: BaselineTrial[], profile: string) => {
    const selected = trials.filter((trial) => trial.config === profile && trial.included_in_score);
    if (selected.length === 0) throw new Error(`no scored trials for baseline profile ${profile}`);
    for (const trial of selected) {
        if (trial.score_value !== 0 && trial.score_value !== 1) {
            throw new TypeError(`${trial.task_name}: baseline score must be binary`);
        }
    }
    const candidates = rows.filter(({ reward }) => reward !== null);
    const tasks = candidates.map((row) => {
        const task = row.task.split("/").at(-1)!;
        const peers = selected.filter((trial) => trial.task_name === task);
        return { task, candidateReward: row.reward!, baselineAttempts: peers.length, baselinePassed: score(peers.map((trial) => trial.score_value)).passed };
    });
    const matched = tasks.filter(({ baselineAttempts }) => baselineAttempts > 0);
    const matchedNames = new Set(matched.map(({ task }) => task));
    const peers = selected.filter((trial) => matchedNames.has(trial.task_name));
    const middle = (read: (trial: BaselineTrial) => number | null | undefined) =>
        median(peers.map(read).filter((value): value is number => value !== null && value !== undefined));
    return {
        profile,
        baselineModels: [...new Set(selected.map(({ model }) => model))],
        baselineReasoning: [...new Set(selected.map(({ reasoning_effort }) => reasoning_effort))],
        matchedTasks: matched.length,
        unmatchedTasks: tasks.filter(({ baselineAttempts }) => baselineAttempts === 0).map(({ task }) => task),
        candidate: score(matched.map(({ candidateReward }) => candidateReward)),
        baseline: {
            score: score(peers.map(({ score_value }) => score_value)),
            medianInputTokens: middle(({ n_input_tokens }) => n_input_tokens),
            medianCacheTokens: middle(({ n_cache_tokens }) => n_cache_tokens),
            medianOutputTokens: middle(({ n_output_tokens }) => n_output_tokens),
            medianAgentSeconds: middle(({ agent_duration_seconds }) => agent_duration_seconds),
        },
        tasks,
    };
};
