// {§benchlet-container-exec} — the long-lived task container the candidate's commands run in.
// One container per run: created from the pinned image with the manifest's network and resource
// limits, the candidate repository mounted at its own host path (so cwd and every path in output
// line up) and at /app (where the image's own tooling expects it), started idle, and removed once
// the candidate finishes, on success and on failure alike. The docker invocations go through an
// injected runner so the lifecycle is a unit under test without a daemon.

export interface ContainerEnvironment {
    readonly image: string;
    readonly network: string;
    readonly cpus: number;
    readonly memoryMb: number;
}

export type ContainerRunner = (command: string, args: string[], options?: { allowFailure?: boolean }) => string;

export interface CandidateExecutionRecord {
    readonly kind: "task-container";
    readonly image: string;
    readonly network: string;
    readonly container: string;
    readonly mounts: readonly string[];
    readonly executors: readonly string[];
}

export default class CandidateContainer {
    readonly #run: ContainerRunner;
    #active: string | undefined;

    constructor(run: ContainerRunner) {
        this.#run = run;
    }

    get active(): string | undefined {
        return this.#active;
    }

    // `docker create` then `docker start`; a failed start leaves nothing running and nothing to
    // stop later, because the created container is removed before the error propagates.
    start(environment: ContainerEnvironment, repository: string): string {
        if (this.#active !== undefined) throw new Error("candidate container already active: " + this.#active);
        const container = this.#run("docker", [
            "create",
            "--network", environment.network,
            "--cpus", String(environment.cpus),
            "--memory", environment.memoryMb + "m",
            "-v", repository + ":" + repository,
            "-v", repository + ":/app",
            "-w", repository,
            environment.image,
            "sleep", "infinity",
        ]).trim();
        try {
            this.#run("docker", ["start", container]);
        } catch (cause) {
            this.#run("docker", ["rm", "--force", container], { allowFailure: true });
            throw new Error(`candidate container ${container} did not start`, { cause });
        }
        this.#active = container;
        return container;
    }

    // Idempotent: the success path and the failure path both call it, and only the first removes.
    stop(): void {
        if (this.#active === undefined) return;
        const container = this.#active;
        this.#active = undefined;
        this.#run("docker", ["rm", "--force", container], { allowFailure: true });
    }

    record(environment: ContainerEnvironment, repository: string, executors: readonly string[]): CandidateExecutionRecord {
        if (this.#active === undefined) throw new Error("candidate container is not active");
        return { kind: "task-container", image: environment.image, network: environment.network, container: this.#active, mounts: [repository, "/app"], executors: [...executors] };
    }
}
