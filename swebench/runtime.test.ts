import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { plurnkEnvironment } from "./runtime.ts";

const root = resolve(import.meta.dirname, "..");

test("{§swebench-network} the candidate inherits route tuning and only its provider's credentials", async () => {
    const env = {
        PLURNK_MODEL: "unrelated",
        PLURNK_MODEL_trial: "deepseek/deepseek-chat",
        PLURNK_PROVIDERS_EFFORT_trial: "high",
        PLURNK_BASEURL_trial: "https://provider.example/v1",
        DEEPSEEK_BASE_URL: "https://provider.example/fallback",
        DEEPSEEK_API_KEY: "selected-fixture-key",
        UNRELATED_API_KEY: "unrelated-fixture-key",
        HOME: "/host-home",
        PATH: "/host-bin",
        NODE_OPTIONS: "--import=/host-injection.mjs",
    };
    assert.deepEqual(await plurnkEnvironment(root, "trial", env), {
        PLURNK_MODEL: "trial", PLURNK_MODEL_trial: env.PLURNK_MODEL_trial,
        PLURNK_PROVIDERS_EFFORT_trial: "high", PLURNK_BASEURL_trial: env.PLURNK_BASEURL_trial,
        DEEPSEEK_BASE_URL: env.DEEPSEEK_BASE_URL, DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    });
});

test("{§swebench-network} an operator-declared credential name replaces catalog names without copying it to a file", async () => {
    const env = {
        PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_API_KEY_ENV: " TEAM_MODEL_KEY ",
        TEAM_MODEL_KEY: "selected-fixture-key", DEEPSEEK_API_KEY: "unused-fixture-key",
    };
    assert.deepEqual(await plurnkEnvironment(root, "deepseek/deepseek-chat", env), {
        PLURNK_MODEL: "deepseek/deepseek-chat",
        PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_API_KEY_ENV: env.PLURNK_PROVIDERS_PROVIDER_DEEPSEEK_API_KEY_ENV,
        TEAM_MODEL_KEY: env.TEAM_MODEL_KEY,
    });
});
