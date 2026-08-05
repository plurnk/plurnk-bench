import { homedir } from "node:os";
import { resolve } from "node:path";

export const requiredClientCheckout = (
    root: string,
    env: NodeJS.ProcessEnv,
    name: string,
): string => {
    const configured = env[name]?.trim();
    if (!configured) {
        throw new Error(`${name} must name an explicit outside-client checkout.`);
    }
    const expanded = configured === "~"
        ? homedir()
        : configured.startsWith("~/")
            ? resolve(homedir(), configured.slice(2))
            : configured;
    return resolve(root, expanded);
};
