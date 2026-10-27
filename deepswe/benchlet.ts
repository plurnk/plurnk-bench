import assert from "node:assert/strict";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { allocateRunDirectory } from "../src/run-directory.ts";
import {
    benchmarksHome,
    loadBenchmarkEnvironment,
    selectedModel,
} from "../src/host-paths.ts";
import { requiredClientCheckout } from "../src/client-checkout.ts";
import CandidateContainer from "../src/candidate-container.ts";
import { webMaterializationProvenance } from "../src/web-materialization.ts";
import {
    addSettledUsd,
    summarizeRequiemAccounting,
    type RequiemAccountingInput,
    type RequiemAccountingSummary,
} from "../src/accounting.ts";
import { candidateIsolation } from "../src/candidate-isolation.ts";
import { assertCleanSources } from "../src/source-provenance.ts";
import { readDigest } from "../src/digest.ts";
import {
    aliasConfiguration,
    candidateOutcome,
    candidatePolicyPath,
    candidatePolicySnapshotPath,
    candidateRecapSnapshotPath,
    candidateTimeoutMs,
    dockerImageId,
    EMPTY_SHA256,
    envFileKeyNames,
    environmentKeyNames,
    EXECUTOR_SHIMS,
    executorShim,
    producedNoPatch,
    recordInfrastructureFailure,
    requiemIsComplete,
    requiemModelAlias,
    resolveFrom,
    runToFiles,
    sha256,
    shell,
    writeExecutorShims,
    writeJson,
    type CommandResult,
    type ContainerExec,
} from "../src/benchlet-runtime.ts";
import {
    baselineInvalidity,
    capturePatches,
    captureTree,
    ensureRepositoryCache,
    environmentExcludedP2p,
    gradeObservations,
    gradePatch,
    isDockerManifest,
    isHostManifest,
    isTreeManifest,
    parseGoTestEvents,
    parseTaskVerifierArtifacts,
    parseTreeVerifierArtifacts,
    prepareCandidateRepository,
    snapshotTask,
    TREE_TASK_ROOT,
    treeInstruction,
    validateFixture,
    withoutExcluded,
    type CtrfReport,
    type DockerManifest,
    type HostManifest,
    type Manifest,
    type OracleConfig,
    type OracleResult,
    type TestObservation,
    type TestStatus,
    type TreeManifest,
    type VerifierReward,
} from "./verifiers.ts";
import {
    digestSummary,
    summarizeFailures,
    type DigestJson,
    type FailureIncident,
    type FailureSummary,
} from "./digest-summary.ts";

export {
    aliasConfiguration,
    baselineInvalidity,
    candidateOutcome,
    candidatePolicyPath,
    candidatePolicySnapshotPath,
    candidateRecapSnapshotPath,
    candidateTimeoutMs,
    captureTree,
    digestSummary,
    EMPTY_SHA256,
    environmentExcludedP2p,
    EXECUTOR_SHIMS,
    executorShim,
    gradeObservations,
    isTreeManifest,
    parseGoTestEvents,
    parseTaskVerifierArtifacts,
    parseTreeVerifierArtifacts,
    producedNoPatch,
    recordInfrastructureFailure,
    requiemIsComplete,
    requiemModelAlias,
    runToFiles,
    summarizeFailures,
    TREE_TASK_ROOT,
    treeInstruction,
    withoutExcluded,
    writeExecutorShims,
    type CommandResult,
    type ContainerExec,
    type CtrfReport,
    type DigestJson,
    type DockerManifest,
    type FailureIncident,
    type FailureSummary,
    type HostManifest,
    type Manifest,
    type OracleConfig,
    type OracleResult,
    type TestObservation,
    type TestStatus,
    type TreeManifest,
    type VerifierReward,
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
const benchRoot = resolve(moduleDir, "..");
let activeRunDir: string | undefined;
let activeStartedAt: Date | undefined;
let activeStage = "preflight";

export const manifestPathForTask = (task: string): string => {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(task)) {
        throw new Error(`invalid benchlet task name: ${task}`);
    }
    return resolve(moduleDir, "benchlet.manifests", `${task}.json`);
};

export const allocateRun = (runsRoot: string, task: string, model: string, family = "deepswe"): string =>
    allocateRunDirectory(runsRoot, [family, task, model]);

const candidateContainer = new CandidateContainer((command, args, options) => shell(command, args, options));
const stopCandidateContainer = (): void => candidateContainer.stop();

const requiemSummary = (path: string): RequiemAccountingSummary => {
    const report = JSON.parse(readFileSync(path, "utf8")) as RequiemAccountingInput;
    return summarizeRequiemAccounting(report);
};

const main = async (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const operatorEnv = loadBenchmarkEnvironment(
        process.env.PLURNK_BENCHLET_OPERATOR_ENV,
        resolve(benchRoot, ".env.defaults"),
    );
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            preflight: { type: "boolean", default: false },
            task: { type: "string" },
            recap: { type: "string" },
        },
        allowPositionals: false,
        strict: true,
    });
    const task = values.task ?? process.env.PLURNK_BENCHLET_TASK;
    const recap = values.recap ?? process.env.PLURNK_BENCHLET_RECAP;
    const candidateRecap = recap === undefined || recap.trim() === "" ? null : resolveFrom(process.cwd(), recap);
    if (task === undefined || task.trim() === "") throw new Error("benchlet requires a task name");
    const manifestPath = manifestPathForTask(task);
    if (!existsSync(manifestPath)) throw new Error(`benchlet has no pinned manifest for task: ${task}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    assert.equal(manifest.task, task, "benchlet manifest task must match its selection");

    const preflightOnly = values.preflight;
    const model = selectedModel();
    const taskCache = resolveFrom(benchRoot, process.env.PLURNK_BENCHLET_TASK_CACHE ?? "");
    const taskDir = resolve(isTreeManifest(manifest) ? resolveFrom(benchRoot, manifest.taskCache) : taskCache, manifest.task);
    const repositoryCacheRoot = resolveFrom(
        benchRoot,
        process.env.PLURNK_BENCHLET_REPOSITORY_CACHE_ROOT ?? "",
    );
    const repositoryCache = resolve(repositoryCacheRoot, `${manifest.task}.git`);
    const runsRoot = resolveFrom(benchRoot, process.env.PLURNK_BENCHLET_RUNS_ROOT ?? benchmarksHome());
    const serviceRoot = resolveFrom(benchRoot, process.env.PLURNK_BENCHLET_SERVICE_ROOT ?? "");
    const clientRoot = requiredClientCheckout(
        benchRoot,
        process.env,
        "PLURNK_BENCHLET_CLIENT_ROOT",
    );
    const candidatePolicy = candidatePolicyPath(serviceRoot);
    const candidateTimeout = isTreeManifest(manifest)
        ? manifest.budgetSeconds
        : Number(process.env.PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC);
    const candidateOverhead = Number(process.env.PLURNK_BENCHLET_CANDIDATE_OVERHEAD_SEC);
    const requiemTimeout = Number(process.env.PLURNK_BENCHLET_REQUIEM_TIMEOUT_SEC);
    const requiemEnabled = process.env.PLURNK_BENCHLET_REQUIEM === "1";
    const requiemModel = requiemModelAlias(
        requiemEnabled,
        process.env.PLURNK_BENCHLET_REQUIEM_MODEL,
        model,
    );
    // -1 is the plurnk "no limit" idiom ({§benchlet-diagnostic}).
    if (!Number.isSafeInteger(candidateTimeout) || candidateTimeout === 0 || candidateTimeout < -1) {
        throw new Error("PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC must be a positive integer, or -1 for no limit");
    }
    const timeless = process.env.PLURNK_BENCHLET_TIMELESS === "1";
    const timelessCap = process.env.PLURNK_BENCHLET_TIMELESS_CAP === undefined
        ? 2
        : Number(process.env.PLURNK_BENCHLET_TIMELESS_CAP);
    if (timeless && (!Number.isFinite(timelessCap) || timelessCap <= 1)) {
        throw new Error("PLURNK_BENCHLET_TIMELESS_CAP must be a number above 1");
    }
    if (timeless && candidateTimeout === -1) {
        throw new Error("PLURNK_BENCHLET_TIMELESS needs a finite PLURNK_BENCHLET_CANDIDATE_TIMEOUT_SEC budget to snapshot at");
    }
    const clientTimeout = timeless ? Math.ceil(candidateTimeout * timelessCap) : candidateTimeout;
    if (!Number.isSafeInteger(candidateOverhead) || candidateOverhead <= 0) {
        throw new Error("PLURNK_BENCHLET_CANDIDATE_OVERHEAD_SEC must be a positive integer");
    }
    if (!Number.isSafeInteger(requiemTimeout) || requiemTimeout <= 0) {
        throw new Error("PLURNK_BENCHLET_REQUIEM_TIMEOUT_SEC must be a positive integer");
    }
    if (!existsSync(operatorEnv)) throw new Error(`operator model environment is missing: ${operatorEnv}`);
    if (!existsSync(candidatePolicy)) throw new Error(`candidate policy is missing: ${candidatePolicy}`);
    if (candidateRecap !== null && !existsSync(candidateRecap)) throw new Error(`candidate recap is missing: ${candidateRecap}`);

    const config = validateFixture(manifest, taskDir);
    const imageId = manifest.environment.kind === "docker"
        ? dockerImageId(manifest.environment.image)
        : null;
    if (isHostManifest(manifest)) ensureRepositoryCache(manifest, repositoryCache);
    const sources = assertCleanSources({ bench: benchRoot, service: serviceRoot, client: clientRoot });

    if (preflightOnly) {
        const preflightRoot = mkdtempSync(resolve(tmpdir(), "plurnk-benchlet-preflight-"));
        try {
            const emptyPatch = resolve(preflightRoot, "baseline.patch");
            writeFileSync(emptyPatch, "");
            const baseline = await gradePatch(
                "preflight",
                emptyPatch,
                resolve(preflightRoot, "oracle"),
                repositoryCache,
                manifest,
                taskDir,
                config,
                null,
                signal,
            );
            const invalid = baselineInvalidity(baseline);
            if (invalid !== null) throw new Error(invalid);
            const excluded = environmentExcludedP2p(baseline);
            if (excluded.length > 0) {
                process.stderr.write(`benchlet: ${excluded.length} pass-to-pass test(s) fail on the pristine baseline here and would be excluded from grading: ${excluded.map(({ nodeId }) => nodeId).join(", ")}\n`);
            }
            process.stdout.write(`${JSON.stringify({ status: "ready", baseline }, null, 2)}\n`);
        } finally {
            rmSync(preflightRoot, { recursive: true, force: true });
        }
        return;
    }

    const runDir = allocateRun(runsRoot, manifest.task, model, isTreeManifest(manifest) ? "terminal-bench" : "deepswe");
    const candidatePolicySnapshot = candidatePolicySnapshotPath(runDir);
    copyFileSync(candidatePolicy, candidatePolicySnapshot);
    const candidateRecapSnapshot = candidateRecap === null ? null : candidateRecapSnapshotPath(runDir);
    if (candidateRecap !== null && candidateRecapSnapshot !== null) copyFileSync(candidateRecap, candidateRecapSnapshot);
    snapshotTask(runDir, manifestPath, manifest, taskDir);
    const startedAt = new Date();
    activeRunDir = runDir;
    activeStartedAt = startedAt;
    const provenance = {
        schemaVersion: 1,
        state: "running",
        startedAt: startedAt.toISOString(),
        invocation: {
            command: relative(benchRoot, resolve(moduleDir, "benchlet.sh")),
            args: ["--task", manifest.task],
            env: { PLURNK_MODEL: model, ...(timeless ? { PLURNK_BENCHLET_TIMELESS: "1" } : {}) },
            cwd: benchRoot,
        },
        task: {
            name: manifest.task,
            repositoryUrl: manifest.repositoryUrl,
            baseCommit: manifest.baseCommit,
            manifestSha256: sha256(manifestPath),
            files: manifest.files,
            ...(isTreeManifest(manifest) ? { instructionRewrite: { from: TREE_TASK_ROOT, to: resolve(runDir, "repo") } } : {}),
            environment: {
                ...manifest.environment,
                imageId,
            },
            verifier: manifest.verifier,
        },
        modelAlias: model,
        // {§bench-relock}
        aliasConfiguration: aliasConfiguration(model, process.env),
        sources,
        webMaterialization: webMaterializationProvenance(process.env),
        runtime: {
            node: process.version,
            platform: process.platform,
            arch: process.arch,
        },
        configuration: {
            candidateTimeoutSeconds: candidateTimeout,
            candidateOverheadSeconds: candidateOverhead,
            requiemTimeoutSeconds: requiemTimeout,
            requiemModelAlias: requiemModel,
            oracleSuiteTimeoutSeconds: manifest.verifier.kind === "go"
                ? Object.fromEntries(
                    manifest.verifier.suites.map((suite) => [suite.name, suite.timeoutSeconds]),
                )
                : null,
            oracleTaskTimeoutSeconds: manifest.verifier.kind === "task" || manifest.verifier.kind === "tree"
                ? manifest.verifier.timeoutSeconds
                : null,
            requiemEnabled,
            operatorEnv,
            operatorEnvKeys: envFileKeyNames(operatorEnv),
            candidatePolicy: {
                sourcePath: candidatePolicy,
                snapshotPath: candidatePolicySnapshot,
                sha256: sha256(candidatePolicySnapshot),
            },
            candidateRecap: candidateRecap === null || candidateRecapSnapshot === null ? null : {
                sourcePath: candidateRecap,
                snapshotPath: candidateRecapSnapshot,
                sha256: sha256(candidateRecapSnapshot),
            },
            shellCredentialKeys: environmentKeyNames(process.env),
        },
    };
    writeJson(resolve(runDir, "provenance.json"), provenance);

    activeStage = "oracle-baseline";
    const emptyPatch = resolve(runDir, "baseline.patch");
    writeFileSync(emptyPatch, "");
    const baseline = await gradePatch(
        "baseline",
        emptyPatch,
        resolve(runDir, "oracle-baseline"),
        repositoryCache,
        manifest,
        taskDir,
        config,
        null,
        signal,
    );
    writeJson(resolve(runDir, "oracle-baseline.json"), baseline);
    const invalid = baselineInvalidity(baseline);
    if (invalid !== null) throw new Error(invalid);
    const excludedP2p = environmentExcludedP2p(baseline);
    const runConfig = withoutExcluded(config, excludedP2p);
    writeJson(resolve(runDir, "oracle-exclusions.json"), {
        p2p: excludedP2p.map(({ nodeId, output }) => ({ nodeId, baselineOutput: output })),
        p2pGraded: runConfig.p2p_node_ids.length,
        p2pPinned: config.p2p_node_ids.length,
    });
    if (excludedP2p.length > 0) {
        process.stderr.write(`benchlet: excluding ${excludedP2p.length} pass-to-pass test(s) that fail on the pristine baseline here: ${excludedP2p.map(({ nodeId }) => nodeId).join(", ")}\n`);
    }

    const repository = resolve(runDir, "repo");
    prepareCandidateRepository(manifest, repositoryCache, repository);
    // {§benchlet-diagnostic}
    const instructionSource = readFileSync(resolve(taskDir, "instruction.md"), "utf8");
    const instruction = isTreeManifest(manifest) ? treeInstruction(instructionSource, repository) : instructionSource;
    const candidateArgs = [
        "scripts/candidate.mjs",
        "--yolo",
        "--project-root",
        repository,
        ...(clientTimeout === -1 ? [] : ["--timeout", String(clientTimeout)]),
        instruction,
    ];
    // {§benchlet-diagnostic}
    const containerExec = isDockerManifest(manifest)
        ? (() => {
            const user = process.getuid!() + ":" + process.getgid!();
            const mounts = { repository, scratch: resolve(runDir, "exec-scratch") };
            const container = candidateContainer.start(manifest.environment, mounts, user);
            const binDir = resolve(runDir, "bin");
            const realPath = process.env.PATH ?? "";
            writeExecutorShims(binDir, { container, repository, user, home: candidateContainer.home!, realPath });
            return {
                env: { PATH: binDir + ":" + realPath, ...candidateContainer.daemonEnvironment() },
                record: candidateContainer.record(manifest.environment, mounts, EXECUTOR_SHIMS),
            };
        })()
        : { env: {}, record: { kind: "host" } };
    writeJson(resolve(runDir, "candidate-execution.json"), containerExec.record);
    // {§benchlet-diagnostic}
    const isolation = candidateIsolation([...envFileKeyNames(operatorEnv), ...Object.keys(process.env)]);
    writeJson(resolve(runDir, "candidate-isolation.json"), { masked: isolation.masked, webHosts: [], capabilities: isolation.capabilities });
    const candidateEnvironmentOverrides = {
        ...isolation.overrides,
        ...containerExec.env,
        PLURNK_CANDIDATE_DIR: runDir,
        PLURNK_MODEL: model,
        PLURNK_CLIENT_CHECKOUT: clientRoot,
        ...(isTreeManifest(manifest) ? { PLURNK_MEMBERS_task: "**", PLURNK_MEMBERS_ENABLED: "1" } : {}),
        PLURNK_SERVICE_POLICY: candidatePolicySnapshot,
        ...(candidateRecapSnapshot === null ? {} : { PLURNK_SERVICE_RECAP: candidateRecapSnapshot }),
        ...(timeless ? { PLURNK_CANDIDATE_GRADE_DEADLINE_SEC: String(candidateTimeout) } : {}),
    };
    writeJson(resolve(runDir, "candidate-command.json"), {
        command: process.execPath,
        args: candidateArgs,
        cwd: serviceRoot,
        environmentOverrides: candidateEnvironmentOverrides,
    });
    activeStage = "candidate";
    // {§pair-sheet}
    const candidateStartedAt = new Date();
    const candidate = await runToFiles(process.execPath, candidateArgs, {
        cwd: serviceRoot,
        env: {
            ...process.env,
            ...candidateEnvironmentOverrides,
        },
        stdoutPath: resolve(runDir, "candidate.stdout.log"),
        stderrPath: resolve(runDir, "candidate.stderr.log"),
        tee: true,
        timeoutMs: candidateTimeoutMs(clientTimeout, candidateOverhead),
        signal,
    });

    const candidateCompletedAt = new Date();
    stopCandidateContainer();
    activeStage = "capture";
    const patchState = isTreeManifest(manifest)
        ? captureTree(repository, runDir)
        : await capturePatches(repository, runDir, manifest.baseCommit, "", signal);
    writeJson(resolve(runDir, "git-state.json"), patchState);
    const digestPath = resolve(runDir, "digest/digest.json");
    if (!existsSync(digestPath)) throw new Error("candidate did not produce a digest");
    const digest = readDigest<DigestJson>(digestPath);
    const summary = digestSummary(digest);
    if (summary.providerRequests === 0) {
        throw new Error("candidate completed no provider exchange; the run is infrastructure, not an oracle attempt");
    }

    activeStage = "oracle-working";
    const workingOracle = await gradePatch(
        "working",
        resolve(runDir, "working.patch"),
        resolve(runDir, "oracle-working"),
        repositoryCache,
        manifest,
        taskDir,
        runConfig,
        repository,
        signal,
    );
    writeJson(resolve(runDir, "oracle-working.json"), workingOracle);
    activeStage = "oracle-submission";
    const submissionReusedWorking = patchState.submissionSha256 === patchState.workingSha256;
    const submissionOracle = submissionReusedWorking
        ? workingOracle
        : await gradePatch(
            "submission",
            resolve(runDir, "model.patch"),
            resolve(runDir, "oracle-submission"),
            repositoryCache,
            manifest,
            taskDir,
            runConfig,
            null,
            signal,
        );
    writeJson(resolve(runDir, "oracle-submission.json"), submissionOracle);
    if (submissionReusedWorking) {
        const reuseDir = resolve(runDir, "oracle-submission");
        mkdirSync(reuseDir);
        writeJson(resolve(reuseDir, "reused.json"), {
            reusedFrom: "oracle-working",
            reason: "working.patch and model.patch have identical SHA-256 hashes",
            patchSha256: patchState.submissionSha256,
        });
    }

    let deadlineOracle: Record<string, unknown> | null = null;
    const deadlineRepo = resolve(runDir, "repo@deadline");
    if (timeless && existsSync(deadlineRepo)) {
        activeStage = "oracle-deadline";
        const deadlineState = isTreeManifest(manifest)
            ? captureTree(deadlineRepo, runDir, "deadline-")
            : await capturePatches(deadlineRepo, runDir, manifest.baseCommit, "deadline-", signal);
        const deadlineWorking = await gradePatch(
            "deadline-working",
            resolve(runDir, "deadline-working.patch"),
            resolve(runDir, "oracle-deadline-working"),
            repositoryCache,
            manifest,
            taskDir,
            runConfig,
            deadlineRepo,
            signal,
        );
        writeJson(resolve(runDir, "oracle-deadline-working.json"), deadlineWorking);
        const deadlineReused = deadlineState.submissionSha256 === deadlineState.workingSha256;
        const deadlineSubmission = deadlineReused
            ? deadlineWorking
            : await gradePatch(
                "deadline-submission",
                resolve(runDir, "deadline-model.patch"),
                resolve(runDir, "oracle-deadline-submission"),
                repositoryCache,
                manifest,
                taskDir,
                runConfig,
                null,
                signal,
            );
        writeJson(resolve(runDir, "oracle-deadline-submission.json"), deadlineSubmission);
        deadlineOracle = {
            budgetSeconds: candidateTimeout,
            capSeconds: clientTimeout,
            git: deadlineState,
            working: deadlineWorking,
            submission: deadlineSubmission,
            submissionEvidence: { reusedWorking: deadlineReused, patchSha256: deadlineState.submissionSha256 },
        };
    } else if (timeless) {
        deadlineOracle = {
            budgetSeconds: candidateTimeout,
            capSeconds: clientTimeout,
            finishedWithinBudget: true,
            git: patchState,
            working: workingOracle,
            submission: submissionOracle,
            submissionEvidence: { reusedWorking: submissionReusedWorking, patchSha256: patchState.submissionSha256 },
        };
    }

    let requiem: Record<string, unknown> = { enabled: requiemEnabled, status: null };
    if (requiemModel !== null) {
        activeStage = "requiem";
        const requiemArgs = [
            `--env-file=${operatorEnv}`,
            "--conditions=plurnk-dev",
            "plurnk-core/src/service.ts",
            "requiem",
            resolve(runDir, "plurnk.db"),
            resolve(runDir, "digest"),
        ];
        const result = await runToFiles(process.execPath, requiemArgs, {
            cwd: serviceRoot,
            env: {
                ...process.env,
                PLURNK_MODEL: requiemModel,
            },
            stdoutPath: resolve(runDir, "requiem.stdout.log"),
            stderrPath: resolve(runDir, "requiem.stderr.log"),
            tee: true,
            timeoutMs: requiemTimeout * 1_000,
            signal,
        });
        const markdownPath = resolve(runDir, "digest/requiem.md");
        const reportPath = resolve(runDir, "digest/requiem.json");
        const complete = requiemIsComplete(
            result.status,
            existsSync(markdownPath),
            existsSync(reportPath),
        );
        requiem = {
            enabled: true,
            modelAlias: requiemModel,
            status: result.status,
            signal: result.signal,
            timedOut: result.timedOut,
            error: result.error?.message ?? null,
            complete,
            markdown: existsSync(markdownPath) ? relative(runDir, markdownPath) : null,
            report: existsSync(reportPath) ? relative(runDir, reportPath) : null,
            ...(existsSync(reportPath) ? { summary: requiemSummary(reportPath) } : {}),
        };
    }

    activeStage = "finalize";
    const completedAt = new Date();
    // {§benchlet-diagnostic}
    const candidateExit = candidateOutcome(candidate);
    const harnessStatus = candidateExit !== "finished"
        ? "candidate_failed"
        : requiemEnabled && requiem.complete !== true ? "incomplete" : "complete";
    const requiemCostUsd = !requiemEnabled
        ? "0"
        : typeof requiem.summary === "object"
            && requiem.summary !== null
            && "costUsd" in requiem.summary
            && (typeof requiem.summary.costUsd === "string" || requiem.summary.costUsd === null)
            ? requiem.summary.costUsd
            : null;
    writeJson(resolve(runDir, "result.json"), {
        schemaVersion: 2,
        harnessStatus,
        totalCostUsd: addSettledUsd(summary.costUsd, requiemCostUsd),
        candidate: {
            outcome: candidateExit,
            status: candidate.status,
            signal: candidate.signal,
            timedOut: candidate.timedOut,
            error: candidate.error?.message ?? null,
            startedAt: candidateStartedAt.toISOString(),
            completedAt: candidateCompletedAt.toISOString(),
            durationMs: candidateCompletedAt.getTime() - candidateStartedAt.getTime(),
        },
        summary,
        git: patchState,
        oracle: {
            baseline,
            // {§benchlet-diagnostic}
            environmentExcludedP2p: excludedP2p.map(({ nodeId, output }) => ({ nodeId, baselineOutput: output })),
            working: workingOracle,
            submission: submissionOracle,
            submissionEvidence: {
                reusedWorking: submissionReusedWorking,
                patchSha256: patchState.submissionSha256,
                // {§benchlet-diagnostic}
                emptyPatch: producedNoPatch(patchState.submissionSha256),
            },
        },
        deadlineOracle,
        requiem,
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(),
    });
    writeJson(resolve(runDir, "provenance.json"), {
        ...provenance,
        state: "complete",
        completedAt: completedAt.toISOString(),
    });
    process.stdout.write(`artifact=${runDir}\n`);
    if (harnessStatus !== "complete") process.exitCode = 1;
};

if (import.meta.main) {
    const interruption = new AbortController();
    const onSigint = (): void => interruption.abort(new Error("benchlet interrupted by SIGINT"));
    const onSigterm = (): void => interruption.abort(new Error("benchlet interrupted by SIGTERM"));
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    void main(interruption.signal).catch((error) => {
        stopCandidateContainer();
        const rendered = error instanceof Error ? error.stack ?? error.message : String(error);
        process.stderr.write(`${rendered}\n`);
        if (activeRunDir !== undefined) {
            recordInfrastructureFailure(activeRunDir, activeStage, activeStartedAt, error);
            process.stderr.write(`artifact=${activeRunDir}\n`);
        }
        process.exitCode = 1;
    }).finally(() => {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
    });
}
