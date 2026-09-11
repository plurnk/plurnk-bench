// {§pair-mini-digest} — a mini-swe-agent trial read into the same per-step shape the plurnk digest
// gives a turn: the model's words, its command, what came back, and what it cost. Read from the
// trial's `agent/mini-swe-agent.trajectory.json` (OpenAI Responses objects interleaved with
// `function_call_output` observations); rendered as `steps.md` and `steps.json` beside the plurnk
// side so a pair is read in one reader. Fields mini cannot supply are absent, never zero.
import { readFileSync } from "node:fs";

interface ResponseUsage {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly input_tokens_details?: { readonly cached_tokens?: number | null } | null;
}
interface OutputItem {
    readonly type: string;
    readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly summary?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly name?: string;
    readonly arguments?: string;
    readonly call_id?: string;
}
type Message =
    | { readonly role: "system" | "user" | "assistant"; readonly content: string }
    | { readonly role: "exit"; readonly extra?: { readonly exit_status?: string; readonly submission?: string } }
    | { readonly object: "response"; readonly output: readonly OutputItem[]; readonly usage?: ResponseUsage; readonly model?: string }
    | { readonly type: "function_call_output"; readonly call_id: string; readonly output: string; readonly extra?: { readonly raw_output?: string } };

export interface MiniStep {
    readonly index: number;                 // 1-based response ordinal
    readonly text: string | null;           // the assistant's own words in that response
    readonly reasoning: string | null;      // the provider's reasoning summary when the response carried one
    readonly command: string | null;        // the bash command the response called
    readonly returncode: number | null;     // from the observation that answered the call
    readonly outputLines: number | null;    // total lines of the observation
    readonly outputHead: string | null;     // the first lines of the observation
    readonly usage: { readonly input: number; readonly cached: number; readonly output: number } | null;
}

export interface MiniTrajectory {
    readonly model: string | null;
    readonly task: string | null;
    readonly steps: readonly MiniStep[];
    readonly exit: { readonly status: string | null; readonly submission: string | null };
    readonly totals: { readonly responses: number; readonly input: number; readonly cached: number; readonly output: number; readonly reasoningResponses: number };
}

const HEAD_LINES = 12;

const isResponse = (m: Message): m is Extract<Message, { object: "response" }> => (m as { object?: string }).object === "response";
const isObservation = (m: Message): m is Extract<Message, { type: "function_call_output" }> => (m as { type?: string }).type === "function_call_output";

export default class MiniTrajectoryReader {
    static read(path: string): MiniTrajectory {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as { messages?: Message[]; info?: { config?: { agent?: { model?: string | null } } } };
        if (!Array.isArray(parsed.messages)) throw new Error(`${path}: no messages array; not a mini-swe-agent trajectory`);
        return MiniTrajectoryReader.fromMessages(parsed.messages, parsed.info?.config?.agent?.model ?? null);
    }

    static fromMessages(messages: readonly Message[], model: string | null): MiniTrajectory {
        const observations = new Map<string, Extract<Message, { type: "function_call_output" }>>();
        for (const m of messages) if (isObservation(m)) observations.set(m.call_id, m);
        const steps: MiniStep[] = [];
        let responseModel = model;
        let totals = { responses: 0, input: 0, cached: 0, output: 0, reasoningResponses: 0 };
        for (const m of messages) {
            if (!isResponse(m)) continue;
            responseModel ??= m.model ?? null;
            const text = m.output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []).filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("\n").trim();
            const reasoning = m.output.filter((o) => o.type === "reasoning").flatMap((o) => o.summary ?? []).map((s) => s.text ?? "").join("\n").trim();
            const call = m.output.find((o) => o.type === "function_call" && o.name === "bash");
            let command: string | null = null;
            if (call?.arguments !== undefined) {
                try { command = (JSON.parse(call.arguments) as { command?: string }).command ?? null; } catch { command = call.arguments; }
            }
            const observation = call?.call_id === undefined ? undefined : observations.get(call.call_id);
            let returncode: number | null = null; let outputText: string | null = null;
            if (observation !== undefined) {
                try {
                    const payload = JSON.parse(observation.output) as { returncode?: number; output?: string };
                    returncode = payload.returncode ?? null; outputText = payload.output ?? observation.extra?.raw_output ?? null;
                } catch { outputText = observation.extra?.raw_output ?? observation.output; }
            }
            const lines = outputText === null ? null : outputText.split("\n");
            const usage = m.usage === undefined ? null : {
                input: m.usage.input_tokens ?? 0,
                cached: m.usage.input_tokens_details?.cached_tokens ?? 0,
                output: m.usage.output_tokens ?? 0,
            };
            totals = {
                responses: totals.responses + 1,
                input: totals.input + (usage?.input ?? 0),
                cached: totals.cached + (usage?.cached ?? 0),
                output: totals.output + (usage?.output ?? 0),
                reasoningResponses: totals.reasoningResponses + (reasoning.length > 0 ? 1 : 0),
            };
            steps.push({
                index: steps.length + 1,
                text: text.length > 0 ? text : null,
                reasoning: reasoning.length > 0 ? reasoning : null,
                command,
                returncode,
                outputLines: lines === null ? null : lines.length,
                outputHead: lines === null ? null : lines.slice(0, HEAD_LINES).join("\n"),
                usage,
            });
        }
        const exit = messages.find((m): m is Extract<Message, { role: "exit" }> => (m as { role?: string }).role === "exit");
        const user = messages.find((m) => (m as { role?: string }).role === "user") as { content?: string } | undefined;
        const task = user?.content ?? null;
        return {
            model: responseModel,
            task,
            steps,
            exit: { status: exit?.extra?.exit_status ?? null, submission: exit?.extra?.submission ?? null },
            totals,
        };
    }

    // The per-step waterfall, one section per response, in the plurnk digest's register.
    static render(trajectory: MiniTrajectory): string {
        const out: string[] = [];
        out.push("# mini-swe-agent steps", "");
        out.push(`Model: ${trajectory.model ?? "unknown"}  Responses: ${trajectory.totals.responses}  Exit: ${trajectory.exit.status ?? "unknown"}`);
        out.push(`Tokens: input=${trajectory.totals.input} cached=${trajectory.totals.cached} output=${trajectory.totals.output}  Reasoning responses: ${trajectory.totals.reasoningResponses}`, "");
        for (const step of trajectory.steps) {
            out.push(`## step ${step.index}`);
            if (step.reasoning !== null) out.push("", "> " + step.reasoning.replaceAll("\n", "\n> "));
            if (step.text !== null) out.push("", step.text);
            if (step.command !== null) out.push("", "```bash", step.command, "```");
            if (step.returncode !== null || step.outputLines !== null) {
                out.push("", `exit ${step.returncode ?? "?"}, ${step.outputLines ?? 0} lines`);
                if (step.outputHead !== null && step.outputHead.length > 0) out.push("", "```", step.outputHead, ...(step.outputLines !== null && step.outputLines > HEAD_LINES ? [`… ${step.outputLines - HEAD_LINES} more lines`] : []), "```");
            }
            if (step.usage !== null) out.push("", `tokens: input=${step.usage.input} cached=${step.usage.cached} output=${step.usage.output}`);
            out.push("");
        }
        return out.join("\n");
    }
}
