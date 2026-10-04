// {§swebench-pi} Native Pi, sharing the Plurnk trial's specimen and evaluator machinery.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { jobsRoot } from "../src/host-paths.ts";
import { modelHosts, runContainer } from "./container.ts";
import { installedPiRoot, prepareRuntime } from "./runtime.ts";
import { capturePatch, dockerImageId, exceptionInfo, prepareRepository, pruneImage, requireDiskRoom, shell, taskPrompt } from "./run.ts";

const directory = dirname(fileURLToPath(import.meta.url));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

const HOSTED_CREDENTIALS = { openrouter: "OPENROUTER_API_KEY", deepseek: "DEEPSEEK_API_KEY", fireworks: "FIREWORKS_API_KEY" };
const LOCAL_CREDENTIAL = "PLURNK_PI_LOCAL_KEY";

// The provider definition Pi reads from models.json for a baseUrl profile, as the native test writes it.
export const providerDefinition = (profile, credential) => ({ providers: { [profile.provider]: {
    baseUrl: profile.baseUrl, api: profile.api, apiKey: `$${credential}`,
    models: [{ id: profile.model, reasoning: true, input: ["text"], contextWindow: profile.contextWindow, maxTokens: profile.maxOutputTokens, cost: profile.rates }],
} } });

export const profileCredential = (profile) =>
    HOSTED_CREDENTIALS[profile.provider] ?? profile.credential ?? (profile.baseUrl ? LOCAL_CREDENTIAL : null);

// A hosted model is its entry in Pi's frozen catalog; a baseUrl provider's model is the profile's own
// definition, the one the comparator writes for Pi, which the catalog never carries.
export const selectedModel = (profile, catalog, credential) => {
    if (profile.baseUrl) return providerDefinition(profile, credential).providers[profile.provider].models[0];
    const model = catalog[profile.provider]?.models.find((item) => item.id === profile.model);
    if (!model) throw new Error("The selected model is absent from Pi's frozen catalog; refresh with pi update --models");
    return model;
};

export function validateProfile(profile) {
    // {§swebench-pi} A hosted provider path, or any OpenAI-compatible endpoint named by baseUrl and api
    // (a local llama-server among them): the comparator then writes Pi's own provider definition.
    if (!HOSTED_CREDENTIALS[profile.provider]) {
        if (typeof profile.baseUrl !== "string" || !/^https?:\/\//.test(profile.baseUrl)) throw new Error("The Pi comparator profile supports the openrouter, deepseek and fireworks providers, or any provider with a baseUrl and api");
        if (!["openai-completions", "anthropic-messages"].includes(profile.api)) throw new Error("A baseUrl provider needs api openai-completions or anthropic-messages");
        for (const key of ["contextWindow", "maxOutputTokens"]) if (!Number.isSafeInteger(profile[key]) || profile[key] <= 0) throw new Error(`A baseUrl provider needs a positive ${key}`);
        if (profile.credential !== undefined && (typeof profile.credential !== "string" || !profile.credential)) throw new Error("credential names an environment variable, never a value");
    }
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

// An explicit Node binary avoids an unrelated shebang selection in installed-CLI tests.
export const piLaunch = (executable, args) => ({ command: process.execPath, args: [realpathSync(executable), ...args] });

export function piArguments(profile, sessionDir, prompt, extension = join(directory, "pi-extension.mjs")) {
    return ["--print", "--mode", "json", "--provider", profile.provider, "--model", profile.model,
        "--thinking", profile.effort, "--no-extensions",
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline",
        "--extension", extension, "--session-dir", sessionDir, "--", prompt];
}

function responseUsage(frames) {
    const start = frames.find((frame) => frame.type === "message_start");
    if (start) {
        const deltas = frames.filter((frame) => frame.type === "message_delta");
        if (!frames.some((frame) => frame.type === "message_stop") || !deltas.some((frame) => Number.isFinite(frame.usage?.output_tokens))) return;
        const total = Object.assign({}, start.message?.usage, ...deltas.map((frame) => frame.usage));
        return { total, input: total.input_tokens, output: total.output_tokens,
            cacheRead: total.cache_read_input_tokens ?? 0, cacheWrite: total.cache_creation_input_tokens ?? 0,
            reasoning: total.output_tokens_details?.reasoning_tokens };
    }
    const total = frames.findLast((frame) => frame.usage?.prompt_tokens !== undefined)?.usage;
    if (!total) return;
    const cacheRead = total.prompt_tokens_details?.cached_tokens;
    return { total, input: total.prompt_tokens - cacheRead, output: total.completion_tokens,
        cacheRead, cacheWrite: 0, reasoning: total.completion_tokens_details?.reasoning_tokens };
}

export function summarizePi(agentDir, rates) {
    const events = readFileSync(join(agentDir, "pi.stdout.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const messages = events.filter((e) => e.type === "message_end" && e.message?.role === "assistant").map((e) => e.message);
    const captures = join(agentDir, "wire");
    const files = existsSync(captures) ? readdirSync(captures) : [];
    const requests = files.filter((name) => name.endsWith(".request.json"));
    const knownUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
    let chargedUsd = 0;
    let unpricedRequests = 0;
    let responsesWithUsage = 0;
    let responsesWithTokenBreakdown = 0;
    let responsesWithReasoningBreakdown = 0;
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
        const tokens = responseUsage(frames);
        const httpPath = join(captures, `${stem}.http.json`);
        const status = existsSync(httpPath) ? JSON.parse(readFileSync(httpPath, "utf8")).status : null;
        if (status === null || status >= 400) failures.push({ request: stem, status });
        if (files.includes(`${stem}.capture-error.json`)) failures.push({ request: stem, error: "Response capture interrupted" });
        const billing = Object.assign({}, ...frames.flatMap((frame) => [frame.message?.usage, frame.usage]));
        const upstream = billing.cost_details?.upstream_inference_cost;
        if (typeof billing.cost === "number" && (billing.is_byok === false || (billing.is_byok === true && typeof upstream === "number"))) {
            chargedUsd += billing.cost + (billing.is_byok ? upstream : 0);
        } else unpricedRequests++;
        if (!tokens) continue;
        const { input, output, cacheRead, cacheWrite, reasoning } = tokens;
        responsesWithUsage++;
        if ([input, output, cacheRead, cacheWrite].every((value) => Number.isSafeInteger(value) && value >= 0)) {
            responsesWithTokenBreakdown++;
            knownUsage.input += input;
            knownUsage.cacheRead += cacheRead;
            knownUsage.cacheWrite += cacheWrite;
            knownUsage.output += output;
            if (Number.isSafeInteger(reasoning) && reasoning >= 0) {
                responsesWithReasoningBreakdown++;
                knownUsage.reasoning += reasoning;
            }
        }
    }
    const repricedUsd = (knownUsage.input * rates.input + knownUsage.cacheRead * rates.cacheRead + knownUsage.cacheWrite * rates.cacheWrite + knownUsage.output * rates.output) / 1e6;
    const usage = Object.fromEntries(Object.entries(knownUsage).map(([key, value]) => [key,
        (key === "reasoning" ? responsesWithReasoningBreakdown : responsesWithTokenBreakdown) === requests.length ? value : null]));
    const subtotalUsage = Object.fromEntries(Object.entries(knownUsage).map(([key, value]) => [key,
        requests.length === 0 || (key === "reasoning" ? responsesWithReasoningBreakdown : responsesWithTokenBreakdown) > 0 ? value : null]));
    const limits = join(agentDir, "limits.jsonl");
    return { requests: requests.length, responsesWithUsage, responsesWithTokenBreakdown, responsesWithReasoningBreakdown,
        chargedUsd: unpricedRequests === 0 ? chargedUsd : null,
        knownChargedUsd: requests.length === 0 || unpricedRequests < requests.length ? chargedUsd : null,
        unpricedRequests,
        repricedUsd: responsesWithTokenBreakdown === requests.length ? repricedUsd : null,
        knownRepricedUsd: requests.length === 0 || responsesWithTokenBreakdown > 0 ? repricedUsd : null,
        usage, knownUsage: subtotalUsage, failures,
        assistantMessages: messages.length, errors: messages.filter((m) => m.stopReason === "error" || m.stopReason === "aborted").map((m) => ({ stopReason: m.stopReason, error: m.errorMessage })),
        limits: existsSync(limits) ? readFileSync(limits, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    };
}

export async function runPiTrial({ instance, profilePath, preflight = false, signal }) {
    const profile = validateProfile(JSON.parse(readFileSync(profilePath, "utf8")));
    const version = shell(profile.executable, ["--version"]).trim();
    if (version !== profile.version) throw new Error(`Pi version changed: expected ${profile.version}, got ${version}`);
    const credential = profileCredential(profile);
    const model = selectedModel(profile, JSON.parse(readFileSync(profile.catalogPath, "utf8")), credential);
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
    try {
        const allowedHosts = modelHosts(process.env, preflight);
        const runtime = await prepareRuntime({ kind: "pi", piRoot: await installedPiRoot(profile.executable), version });
        json(join(trialDir, "runtime.json"), runtime.provenance);
        const agentDir = join(trialDir, "agent");
        const configDir = join(agentDir, "config");
        mkdirSync(configDir, { recursive: true });
        const config = piConfiguration("/bin/bash");
        json(join(configDir, "settings.json"), config);
        copyFileSync(profile.catalogPath, join(configDir, "models-store.json"));
        if (profile.baseUrl) json(join(configDir, "models.json"), providerDefinition(profile, credential));
        json(join(agentDir, "profile.json"), profile);
        const prompt = taskPrompt(manifest.problemStatement);
        const argv = piArguments(profile, "/logs/agent/sessions", prompt, "/opt/harness/pi-extension.mjs");
        const provenance = { agent: "pi", version, instance, profile, model, imageId, startHead, datasetRevision: manifest.datasetRevision,
            baseCommit: manifest.baseCommit, repository, taskPrompt: prompt, argv, node: process.version, startedAt: new Date().toISOString() };
        json(join(trialDir, "provenance.json"), provenance);
        const result = await runContainer({
            trial: trialDir, runtime: runtime.path, repository, agent: agentDir,
            image: imageId, cpus: manifest.environment.cpus, memoryMb: manifest.environment.memoryMb,
            allowedHosts, preflight, argv: preflight ? ["pi", "--preflight"] : ["pi", ...argv],
            env: { ...(credential && process.env[credential] ? { [credential]: process.env[credential] } : {}),
                ...(credential === LOCAL_CREDENTIAL ? { [LOCAL_CREDENTIAL]: "local" } : {}),
                PI_CODING_AGENT_DIR: "/logs/agent/config", PI_TELEMETRY: "0",
                PLURNK_PI_PROFILE: "/logs/agent/profile.json", PLURNK_PI_AGENT_DIR: "/logs/agent" },
        }, { signal, timeoutMs: profile.timeoutSeconds * 1000 });
        if (preflight) {
            if (result.status !== 0) throw new Error(`Pi preflight failed; see ${trialDir}/container.stderr.log`);
            json(join(trialDir, "preflight.json"), { version, config, argv,
                ...JSON.parse(readFileSync(join(agentDir, "preflight.json"), "utf8")) });
            return trialDir;
        }
        json(join(trialDir, "result.json"), { schemaVersion: 2, trial_name: `pi-${instance}`, task_name: instance,
            config: { agent: { name: "pi", model_name: `${profile.provider}/${profile.model}` } },
            started_at: provenance.startedAt, finished_at: new Date().toISOString(), exception_info: exceptionInfo(result, profile.timeoutSeconds) });
        const patch = capturePatch(repository, startHead, trialDir);
        shell(process.execPath, [join(directory, "evaluate.ts"), "--instance", instance, "--patch", patch, "--out", trialDir, "--label", "pi"], { cwd: resolve(directory, "..") });
        json(join(agentDir, "summary.json"), summarizePi(agentDir, profile.rates));
        return trialDir;
    } finally {
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
