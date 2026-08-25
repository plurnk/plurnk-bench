import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const expandHome = (value: string, home: string): string =>
    value === "~"
        ? home
        : value.startsWith("~/")
            ? resolve(home, value.slice(2))
            : value;

export const operatorConfigPath = (
    override: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): string => {
    if (override !== undefined && override.trim() !== "") {
        return expandHome(override, home);
    }
    const configured = env.XDG_CONFIG_HOME;
    const configHome = configured !== undefined && configured.length > 0 && isAbsolute(configured)
        ? resolve(configured)
        : resolve(home, ".config");
    return resolve(configHome, "plurnk", ".env");
};

// SPEC §results-canon. The ONE tree every harness writes into: published runs at its root,
// each harness's job scratch under jobs/<harness>/. PLURNK_BENCH_HOME overrides the
// default ~/benchmarks; nothing lands inside a repository or elsewhere.
export const benchmarksHome = (
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): string => {
    const configured = env.PLURNK_BENCH_HOME;
    return configured !== undefined && configured.trim() !== ""
        ? resolve(expandHome(configured.trim(), home))
        : resolve(home, "benchmarks");
};

export const jobsRoot = (
    harness: string,
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): string => resolve(benchmarksHome(env, home), "jobs", harness);
