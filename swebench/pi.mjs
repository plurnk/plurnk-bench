// {§swebench-pi} Native Pi, sharing the Plurnk trial's specimen and evaluator machinery.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import CandidateContainer from "../src/candidate-container.ts";
import { jobsRoot } from "../src/host-paths.ts";
import { EXECUTOR_SHIMS, writeExecutorShims } from "./exec.ts";
import { capturePatch, dockerImageId, exceptionInfo, prepareRepository, pruneImage, requireDiskRoom, runToFiles, shell, taskPrompt } from "./run.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

export function validateProfile(profile) {
    if (!["openrouter", "deepseek", "fireworks"].includes(profile.provider)) throw new Error("The Pi comparator profile supports the openrouter, deepseek and fireworks providers");
    for (const key of ["executable", "version", "model", "catalogPath", "effort"]) {
        if (typeof profile[key] !== "string" || !profile[key]) throw new Error(`Pi profile requires ${key}`);
    }
    for (const key of ["turnCap", "timeoutSeconds"]) {
        if (!Number.isSafeInteger(profile[key]) || profile[key] <= 0) throw new Error(`Pi profile requires a positive ${key}`);
    }
    for (const key of ["input", "cacheRead", "cacheWrite", "output"]) {
        if (!Number.isFinite(profile.rates?.[key]) || profile.rates[key] < 0) throw new Error(`Pi profile requires rates.${key}`);
    }
    return profile;
}

export const piConfiguration = (shellPath) => ({ shellPath });

// Pi runs on the host; its own shebang must not select the specimen's node shim.
export const piLaunch = (executable, args) => ({ command: process.execPath, args: [realpathSync(executable), ...args] });

export function piArguments(profile, sessionDir, prompt) {
    return ["--print", "--mode", "json", "--provider", profile.provider, "--model", profile.model,
        "--thinking", profile.effort, "--no-extensions",
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline",
        "--extension", join(directory, "pi-extension.mjs"), "--session-dir", sessionDir, "--", prompt];
}

export function summarizePi(agentDir, rates) {
    const events = readFileSync(join(agentDir, "pi.stdout.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const messages = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => e.message);
    const captures = join(agentDir, "wire");
    const files = existsSync(captures) ? readdirSync(captures) : [];
    const requests = files.filter((name) => name.endsWith(".request.json"));
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    let chargedUsd = 0;
    let unpricedRequests = 0;
    let responsesWithUsage = 0;
    let responsesWithTokenBreakdown = 0;
    const failures = [];
    for (const name of requests) {
        const stem = name.replace(".request.json", "");
        const path = join(captures, `${stem}.response.txt`);
        const body = existsSync(path) ? readFileSync(path, "utf8") : "";
        const frames = [];
        for (const line of body.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")) {
            try { frames.push(JSON.parse(line.slice(6))); }
            catch (error) { failures.push({ request: stem, error: `Incomplete provider frame: ${error.message}` }); }
        }
        const total = frames.findLast((frame) => frame.usage?.prompt_tokens !== undefined)?.usage;
        const httpPath = join(captures, `${stem}.http.json`);
        const status = existsSync(httpPath) ? JSON.parse(readFileSync(httpPath, "utf8")).status : null;
        if (status === null || status >= 400) failures.push({ request: stem, status });
        if (files.includes(`${stem}.capture-error.json`)) failures.push({ request: stem, error: "Response capture interrupted" });
        if (!total) { unpricedRequests++; continue; }
        responsesWithUsage++;
        const cached = total.prompt_tokens_details?.cached_tokens;
        if ([cached, total.prompt_tokens, total.completion_tokens].every(Number.isFinite)) {
            responsesWithTokenBreakdown++;
            usage.input += total.prompt_tokens - cached;
            usage.cacheRead += cached;
            usage.output += total.completion_tokens;
            usage.reasoning += total.completion_tokens_details?.reasoning_tokens ?? 0;
        }
        const upstream = total.cost_details?.upstream_inference_cost;
        if (typeof total.cost === "number" && (total.is_byok === false || (total.is_byok === true && typeof upstream === "number"))) {
            chargedUsd += total.cost + (total.is_byok ? upstream : 0);
        } else unpricedRequests++;
    }
    const repricedUsd = (usage.input * rates.input + usage.cacheRead * rates.cacheRead + usage.output * rates.output) / 1e6;
    const limits = join(agentDir, "limits.jsonl");
    return { requests: requests.length, responsesWithUsage, responsesWithTokenBreakdown, chargedUsd, unpricedRequests, repricedUsd, usage, failures,
        assistantMessages: messages.length, errors: messages.filter((m) => m.stopReason === "error" || m.stopReason === "aborted").map((m) => ({ stopReason: m.stopReason, error: m.errorMessage })),
        limits: existsSync(limits) ? readFileSync(limits, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    };
}

export async function runPiTrial({ instance, profilePath, preflight = false, signal }) {
    const profile = validateProfile(JSON.parse(readFileSync(profilePath, "utf8")));
    const version = shell(profile.executable, ["--version"]).trim();
    if (version !== profile.version) throw new Error(`Pi version changed: expected ${profile.version}, got ${version}`);
    const catalog = JSON.parse(readFileSync(profile.catalogPath, "utf8"));
    const model = catalog[profile.provider]?.models.find((item) => item.id === profile.model);
    if (!model) throw new Error("The selected model is absent from Pi's frozen catalog; refresh with pi update --models");
    const manifest = JSON.parse(readFileSync(join(directory, "manifests", `${instance}.json`), "utf8"));
    if (manifest.instance !== instance) throw new Error("Pi specimen identity mismatch");
    const root = jobsRoot("swebench-pi");
    mkdirSync(root, { recursive: true });
    const trialDir = mkdtempSync(join(root, `${instance}-`));
    console.log(`artifact=${trialDir}`);
    requireDiskRoom();
    const imageId = dockerImageId(manifest.environment.image);
    const repository = join(trialDir, "repo");
    const startHead = prepareRepository(manifest, repository);
    const container = new CandidateContainer(shell);
    const user = `${process.getuid()}:${process.getgid()}`;
    try {
        // {§benchlet-container-scratch}: the mount is the container contract's; Pi runs no daemon that writes there.
        const mounts = { repository, scratch: join(trialDir, "exec-scratch"), containerRoot: "/testbed" };
        const id = container.start(manifest.environment, mounts, user);
        const binDir = join(trialDir, "bin");
        writeExecutorShims(binDir, { container: id, repository, user, home: container.home, realPath: process.env.PATH ?? "" });
        json(join(trialDir, "candidate-execution.json"), container.record(manifest.environment, mounts, EXECUTOR_SHIMS));
        const agentDir = join(trialDir, "agent");
        const configDir = join(agentDir, "config");
        mkdirSync(configDir, { recursive: true });
        const config = piConfiguration(join(binDir, "bash"));
        json(join(configDir, "settings.json"), config);
        copyFileSync(profile.catalogPath, join(configDir, "models-store.json"));
        json(join(agentDir, "profile.json"), profile);
        const prompt = taskPrompt(manifest.problemStatement);
        const argv = piArguments(profile, join(agentDir, "sessions"), prompt);
        const launch = piLaunch(profile.executable, argv);
        const provenance = { agent: "pi", version, instance, profile, model, imageId, startHead, datasetRevision: manifest.datasetRevision,
            baseCommit: manifest.baseCommit, repository, taskPrompt: prompt, argv, launch, node: process.version, startedAt: new Date().toISOString() };
        json(join(trialDir, "provenance.json"), provenance);
        if (preflight) {
            const output = shell(join(binDir, "bash"), ["-c", "python -c 'import sys; print(sys.executable)'"], { cwd: repository });
            if (!output.includes("/opt/miniconda3/envs/testbed/bin/python")) throw new Error(`Pi bash did not reach the testbed interpreter: ${output}`);
            json(join(trialDir, "preflight.json"), { version, output, config, argv });
            return trialDir;
        }
        const result = await runToFiles(launch.command, launch.args, { cwd: repository, signal,
            env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: configDir, PI_TELEMETRY: "0",
                PLURNK_PI_PROFILE: join(agentDir, "profile.json"), PLURNK_PI_AGENT_DIR: agentDir, NODE_OPTIONS: "" },
            stdoutPath: join(agentDir, "pi.stdout.jsonl"), stderrPath: join(agentDir, "pi.stderr.log"), timeoutMs: profile.timeoutSeconds * 1000,
        });
        container.stop();
        json(join(trialDir, "result.json"), { schemaVersion: 2, trial_name: `pi-${instance}`, task_name: instance,
            config: { agent: { name: "pi", model_name: `${profile.provider}/${profile.model}` } },
            started_at: provenance.startedAt, finished_at: new Date().toISOString(), exception_info: exceptionInfo(result, profile.timeoutSeconds) });
        const patch = capturePatch(repository, startHead, trialDir);
        shell(process.execPath, [join(directory, "evaluate.ts"), "--instance", instance, "--patch", patch, "--out", trialDir, "--label", "pi"], { cwd: resolve(directory, "..") });
        json(join(agentDir, "summary.json"), summarizePi(agentDir, profile.rates));
        return trialDir;
    } finally {
        container.stop();
        pruneImage(manifest.environment.image);
    }
}

if (import.meta.main) {
    const { values } = parseArgs({ options: { instance: { type: "string" }, profile: { type: "string" }, preflight: { type: "boolean" } } });
    if (!values.instance || !values.profile) throw new Error("usage: node swebench/pi.mjs --instance ID --profile FILE [--preflight]");
    const abort = new AbortController();
    process.once("SIGTERM", () => abort.abort(new Error("Pi benchmark stopped")));
    process.once("SIGINT", () => abort.abort(new Error("Pi benchmark interrupted")));
    await runPiTrial({ instance: values.instance, profilePath: resolve(values.profile), preflight: values.preflight, signal: abort.signal });
}
