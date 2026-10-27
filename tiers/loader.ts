import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const serviceCore = resolve(process.env.PLURNK_TIERS_SERVICE_ROOT ?? process.cwd());
const harnessUrl = pathToFileURL(resolve(serviceCore, "test/harness.ts")).href;
const parentURL = pathToFileURL(resolve(serviceCore, "package.json")).href;

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier === "@plurnk/plurnk-service/harness") {
            return nextResolve(harnessUrl, context);
        }
        if (specifier.startsWith("@plurnk/")) {
            return nextResolve(specifier, { ...context, parentURL });
        }
        try {
            return nextResolve(specifier, context);
        } catch (error) {
            if (
                !specifier.startsWith(".")
                && !specifier.startsWith("/")
                && !specifier.startsWith("file:")
                && !specifier.startsWith("node:")
            ) {
                return nextResolve(specifier, { ...context, parentURL });
            }
            throw error;
        }
    },
});
