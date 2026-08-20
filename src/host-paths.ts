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
