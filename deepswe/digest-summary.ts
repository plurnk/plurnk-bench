import {
    summarizeDigestAccounting,
    type ProviderAccountingProjection,
    type ProviderUsageProjection,
} from "../src/accounting.ts";

export interface DigestJson {
    workspaces: Array<{
        accounting: ProviderAccountingProjection | null;
    }>;
    workers: Array<{
        id: number;
        name: string;
    }>;
    loops: Array<{
        id: number;
        worker_id: number;
        sequence: number;
        status: number;
        terminated_by: string | null;
        result: {
            status: number;
            content?: string;
            problem?: Record<string, unknown> | null;
        } | null;
    }>;
    turns: Array<{
        id: number;
        model: string | null;
    }>;
    turn_attempts: Array<{
        accepted: boolean | null;
    }>;
    provider_requests: Array<{
        kind: string;
        accounting: { model: string } | null;
    }>;
    log_entries: Array<{
        id: number;
        worker_id: number;
        origin: string;
        op: string | null;
        target: string | null;
        source?: string | null;
        status_rx: number;
        attrs: Record<string, unknown>;
        problem?: {
            type?: string;
            title?: string;
            detail?: string;
            instance?: string;
            [key: string]: unknown;
        } | null;
    }>;
}

export interface FailureIncident {
    kind: "operation" | "stream";
    workerId: number;
    address: string;
    operation: string | null;
    operationEntryId: number | null;
    status: number;
    problemType: string;
    title: string | null;
    detail: string | null;
    observationRows: number;
    channels: string[];
}

export interface FailureSummary {
    observationRows: number;
    problemTypes: Record<string, number>;
    incidents: FailureIncident[];
}

const failureText = (
    problem: DigestJson["log_entries"][number]["problem"],
    field: "type" | "title" | "detail" | "instance",
): string | null => typeof problem?.[field] === "string" ? problem[field] : null;

const terminalStreamObservation = (
    entry: DigestJson["log_entries"][number],
): { address: string; channel: string | null } | null => {
    if (entry.origin !== "plurnk"
        || entry.op !== "READ"
        || entry.attrs.terminal !== true
        || entry.target === null
        || !URL.canParse(entry.target)) return null;
    const address = new URL(entry.target);
    const channel = address.hash.length > 1 ? address.hash.slice(1) : null;
    address.hash = "";
    return { address: address.toString(), channel };
};

const streamNamespace = (entry: DigestJson["log_entries"][number]): string =>
    typeof entry.source === "string" && entry.source.startsWith("worker://") ? entry.source : "";

export const summarizeFailures = (entries: DigestJson["log_entries"]): FailureSummary => {
    const streamOwners = new Map<string, DigestJson["log_entries"][number]>();
    for (const entry of entries) {
        const stream = entry.attrs.stream;
        if (typeof stream !== "string") continue;
        const key = `${entry.worker_id}\u0000${streamNamespace(entry)}\u0000${stream}`;
        const previous = streamOwners.get(key);
        if (previous !== undefined && previous.id !== entry.id) {
            throw new Error(`digest assigns stream ${stream} to multiple log entries for worker ${entry.worker_id}`);
        }
        streamOwners.set(key, entry);
    }

    let observationRows = 0;
    const incidents: FailureIncident[] = [];
    const streamIncidents = new Map<string, FailureIncident>();
    for (const entry of entries) {
        if (entry.status_rx < 400) continue;
        observationRows += 1;
        const problemType = failureText(entry.problem, "type") ?? "unknown";
        const title = failureText(entry.problem, "title");
        const detail = failureText(entry.problem, "detail");
        const stream = terminalStreamObservation(entry);
        if (stream === null) {
            incidents.push({
                kind: "operation",
                workerId: entry.worker_id,
                address: failureText(entry.problem, "instance") ?? `log-entry:${entry.id}`,
                operation: entry.op,
                operationEntryId: entry.id,
                status: entry.status_rx,
                problemType,
                title,
                detail,
                observationRows: 1,
                channels: [],
            });
            continue;
        }

        const key = `${entry.worker_id}\u0000${streamNamespace(entry)}\u0000${stream.address}`;
        const existing = streamIncidents.get(key);
        if (existing !== undefined) {
            if (existing.status !== entry.status_rx || existing.problemType !== problemType) {
                throw new Error(`digest reports conflicting terminal failures for stream ${stream.address}`);
            }
            existing.observationRows += 1;
            if (stream.channel !== null && !existing.channels.includes(stream.channel)) {
                existing.channels.push(stream.channel);
                existing.channels.sort();
            }
            continue;
        }

        const owner = streamOwners.get(`${entry.worker_id}\u0000${streamNamespace(entry)}\u0000${stream.address}`);
        const incident: FailureIncident = {
            kind: "stream",
            workerId: entry.worker_id,
            address: stream.address,
            operation: owner?.op ?? null,
            operationEntryId: owner?.id ?? null,
            status: entry.status_rx,
            problemType,
            title,
            detail,
            observationRows: 1,
            channels: stream.channel === null ? [] : [stream.channel],
        };
        streamIncidents.set(key, incident);
        incidents.push(incident);
    }

    const problemTypes: Record<string, number> = {};
    for (const incident of incidents) {
        problemTypes[incident.problemType] = (problemTypes[incident.problemType] ?? 0) + 1;
    }
    return { observationRows, problemTypes, incidents };
};

export const digestSummary = (digest: DigestJson): {
    modelTurns: number;
    providerRequests: number;
    rejectedEmissions: number;
    models: string[];
    usage: ProviderUsageProjection | null;
    costUsd: string | null;
    loopOutcomes: Array<{
        workerId: number;
        workerName: string | null;
        loop: number;
        status: number;
        terminalMessage: string | null;
        terminatedBy: string | null;
        problem: Record<string, unknown> | null;
    }>;
    operationCounts: Record<string, number>;
    failures: FailureSummary;
} => {
    const operationCounts: Record<string, number> = {};
    for (const entry of digest.log_entries) {
        if (entry.origin !== "model" || entry.op === null) continue;
        operationCounts[entry.op] = (operationCounts[entry.op] ?? 0) + 1;
    }
    const accounting = summarizeDigestAccounting(digest);
    const workerNames = new Map(digest.workers.map((worker) => [worker.id, worker.name]));
    return {
        modelTurns: digest.turns.filter((turn) => turn.model !== null && turn.model !== "unknown").length,
        providerRequests: accounting.providerRequests,
        rejectedEmissions: accounting.rejectedEmissions,
        models: accounting.models,
        usage: accounting.usage,
        costUsd: accounting.costUsd,
        loopOutcomes: digest.loops.map((loop) => ({
            workerId: loop.worker_id,
            workerName: workerNames.get(loop.worker_id) ?? null,
            loop: loop.sequence,
            status: loop.status,
            terminalMessage: typeof loop.result?.content === "string" ? loop.result.content : null,
            terminatedBy: loop.terminated_by,
            problem: loop.result?.problem ?? null,
        })),
        operationCounts,
        failures: summarizeFailures(digest.log_entries),
    };
};
