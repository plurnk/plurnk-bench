// {§benchlet-container-exec} — the long-lived task container the candidate's commands run in.
// One container per run: created from the pinned image with the manifest's network and resource
// limits, the candidate repository mounted at its own host path (so cwd and every path in output
// line up) and at /app (where the image's own tooling expects it), started idle, and removed once
// the candidate finishes, on success and on failure alike. The docker invocations go through an
// injected runner so the lifecycle is a unit under test without a daemon.
// The candidate runs as the host user, so the image's home (where its toolchains and dependency
// caches live: /root/.cargo, /root/go/pkg/mod) is handed to that user at start; the verifier runs
// as the image's own user and sees the same home. Origin (2026-09-17): with HOME=/tmp, wasmi's
// `cargo` was "Permission denied" and participle's Go module cache was empty under network none.
// {§benchlet-container-scratch} — the daemon's executor scratch is the run's own directory,
// mounted at the same absolute path on both sides and named to the daemon by
// PLURNK_SERVICE_EXEC_SCRATCH, so a realized source's host path resolves inside the container.

import { mkdirSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface ContainerEnvironment {
    readonly image: string;
    readonly network: string;
    readonly cpus: number;
    readonly memoryMb: number;
}

export type ContainerRunner = (command: string, args: string[], options?: { allowFailure?: boolean }) => string;

// The candidate repository, mounted at its own host path and at `containerRoot`, and the daemon's
// executor scratch, mounted at its own absolute host path ({§benchlet-container-scratch}).
export interface ContainerMounts {
    readonly repository: string;
    readonly scratch: string;
    readonly containerRoot?: string;
}

export interface CandidateExecutionRecord {
    readonly kind: "task-container";
    readonly image: string;
    readonly network: string;
    readonly container: string;
    readonly home: string;
    readonly scratch: string;
    readonly mounts: readonly string[];
    readonly executors: readonly string[];
}

export default class CandidateContainer {
    readonly #run: ContainerRunner;
    #active: string | undefined;
    #home: string | undefined;
    #scratch: string | undefined;

    constructor(run: ContainerRunner) {
        this.#run = run;
    }

    get active(): string | undefined {
        return this.#active;
    }

    get home(): string | undefined {
        return this.#home;
    }

    // The daemon-side half of the scratch contract: the knob naming the mounted directory.
    daemonEnvironment(): { readonly PLURNK_SERVICE_EXEC_SCRATCH: string } {
        if (this.#scratch === undefined) throw new Error("candidate container is not active");
        return { PLURNK_SERVICE_EXEC_SCRATCH: this.#scratch };
    }

    // `docker create`, `docker start`, then the image's home handed to `user`; a failure at any
    // step leaves nothing running and nothing to stop later, because the created container is
    // removed before the error propagates. The scratch directory exists before the bind mount,
    // else docker creates it root-owned and the daemon cannot write it.
    start(environment: ContainerEnvironment, { repository, scratch, containerRoot = "/app" }: ContainerMounts, user: string): string {
        if (this.#active !== undefined) throw new Error("candidate container already active: " + this.#active);
        if (!isAbsolute(scratch)) throw new Error(`executor scratch must be an absolute host directory: ${scratch}`);
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        const container = this.#run("docker", [
            "create",
            "--network", environment.network,
            "--cpus", String(environment.cpus),
            "--memory", environment.memoryMb + "m",
            "-v", repository + ":" + repository,
            "-v", repository + ":" + containerRoot,
            "-v", scratch + ":" + scratch,
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
        try {
            this.#home = this.#handHome(container, user);
        } catch (cause) {
            this.#run("docker", ["rm", "--force", container], { allowFailure: true });
            throw new Error(`candidate container ${container} home could not be handed to ${user}`, { cause });
        }
        this.#active = container;
        this.#scratch = scratch;
        return container;
    }

    #handHome(container: string, user: string): string {
        const home = this.#run("docker", ["exec", container, "sh", "-c", 'printf %s "$HOME"']).trim();
        if (!home.startsWith("/") || home === "/") throw new Error(`image home ${JSON.stringify(home)} is not a directory to hand over`);
        this.#run("docker", ["exec", "-u", "0", container, "chown", "-R", user, home]);
        return home;
    }

    // Idempotent: the success path and the failure path both call it, and only the first removes.
    stop(): void {
        if (this.#active === undefined) return;
        const container = this.#active;
        this.#active = undefined;
        this.#home = undefined;
        this.#scratch = undefined;
        this.#run("docker", ["rm", "--force", container], { allowFailure: true });
    }

    record(environment: ContainerEnvironment, { repository, scratch, containerRoot = "/app" }: ContainerMounts, executors: readonly string[]): CandidateExecutionRecord {
        if (this.#active === undefined || this.#home === undefined) throw new Error("candidate container is not active");
        return { kind: "task-container", image: environment.image, network: environment.network, container: this.#active, home: this.#home, scratch, mounts: [repository, containerRoot, scratch], executors: [...executors] };
    }
}
