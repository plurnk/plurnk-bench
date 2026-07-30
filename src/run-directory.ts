import {
    mkdirSync,
    readdirSync,
} from "node:fs";
import { resolve } from "node:path";

const labelPart = (value: string): string =>
    value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-");

export const allocateRunDirectory = (
    runsRoot: string,
    labels: readonly string[],
): string => {
    mkdirSync(runsRoot, { recursive: true });
    const entries = readdirSync(runsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    let next = entries.reduce((maximum, entry) => {
        const match = /^run(\d+)(?:-|$)/.exec(entry);
        return match === null ? maximum : Math.max(maximum, Number(match[1]));
    }, 0) + 1;
    const suffix = labels.map(labelPart).join("-");
    while (true) {
        const path = resolve(runsRoot, `run${next}-${suffix}`);
        try {
            mkdirSync(path);
            return path;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            next += 1;
        }
    }
};
