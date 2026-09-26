import { spawnSync } from "node:child_process";

const git = (repository: string, args: string[], options: { allowFailure?: boolean } = {}): string => {
    const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    if (!options.allowFailure && result.status !== 0) {
        throw new Error(`git -C ${repository} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"}): ${`${result.stderr || result.stdout}`.trim()}`);
    }
    return result.stdout;
};

// {§benchlet-provenance}: a run names the exact source it ran, so a dirty tree is refused, not recorded.
export const sourceProvenance = (repository: string): {
    path: string;
    head: string;
    remote: string | null;
    clean: boolean;
    untracked: string[];
} => {
    const status = git(repository, ["status", "--porcelain"]);
    const remote = git(repository, ["remote", "get-url", "origin"], { allowFailure: true }).trim();
    // An untracked path is inert when its top-level segment carries no tracked file at all:
    // it cannot reach the build, so it is recorded rather than refused. Tracked changes and
    // untracked files inside tracked directories still make the source dirty.
    const lines = status.split("\n").filter((line) => line.length > 0);
    const untracked = lines.filter((line) => line.startsWith("?? ")).map((line) => line.slice(3));
    const inert = (path: string): boolean => git(repository, ["ls-files", "--", path.split("/")[0]]).trim() === "";
    const clean = lines.every((line) => line.startsWith("?? ")) && untracked.every(inert);
    return {
        path: repository,
        head: git(repository, ["rev-parse", "HEAD"]).trim(),
        remote: remote === "" ? null : remote,
        clean,
        untracked,
    };
};

export const assertCleanSources = (roots: Readonly<Record<string, string>>): Record<string, ReturnType<typeof sourceProvenance>> => {
    const sources = Object.fromEntries(Object.entries(roots).map(([name, root]) => [name, sourceProvenance(root)]));
    for (const [name, source] of Object.entries(sources)) {
        if (!source.clean) throw new Error(`${name} source is dirty; commit the exact source before a diagnostic run`);
    }
    return sources;
};
