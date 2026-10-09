// {§swebench-friction}
export interface DigestTurn {
    id?: number;
    artifact?: string | null;
    program?: string | null;
}

export interface DigestLogEntry {
    turn_id?: number;
    origin?: string;
    inherited_history?: boolean;
    ambient_event_id?: number | null;
    op?: string | null;
    target?: string | null;
    status_rx?: number | null;
    attrs?: { kind?: string };
    problem?: { type?: string } | null;
}

export interface FrictionInput {
    turns?: DigestTurn[];
    turn_attempts?: Array<{ turn_id?: number }>;
    log_entries?: DigestLogEntry[];
}

export type ReceiptOrigin = "authored" | "automatic" | "ambient" | "inherited" | "unknown";
export type ReceiptCounts = Record<ReceiptOrigin, Record<string, number>>;

export interface TurnFriction {
    modelTurns: number;
    rawEmissions: number;
    fenceFree: number;
    fenceFreeAdmitted: number | null;
    noOperation: number | null;
}

export interface FailureFriction {
    receipts: ReceiptCounts;
    executionStreams: Array<{ path: string; receipts: number }>;
    unaddressedExecutionReceipts: number;
}

export interface Friction {
    turns: TurnFriction | null;
    failures: FailureFriction | null;
}

export const receiptOrigin = (entry: DigestLogEntry): ReceiptOrigin => {
    if (entry.inherited_history === true) return "inherited";
    if (entry.inherited_history !== false) return "unknown";
    if (entry.origin === "model") return "authored";
    if (entry.origin !== "_plurnk" || entry.ambient_event_id === undefined) return "unknown";
    return entry.ambient_event_id === null ? "automatic" : "ambient";
};

const emptyReceipts = (): ReceiptCounts => ({ authored: {}, automatic: {}, ambient: {}, inherited: {}, unknown: {} });
const noOperationProblem = "https://problems.plurnk.xyz/engine/rail/no-operation";
const executorProblem = "https://problems.plurnk.xyz/executor/";

export const frictionOf = (digest: FrictionInput | null): Friction => {
    const entries = digest?.log_entries;
    const attempted = digest?.turn_attempts;
    const turnIds = new Set(attempted?.flatMap(({ turn_id }) => typeof turn_id === "number" ? [turn_id] : []));
    const raw = (digest?.turns ?? []).filter((turn) => turnIds.has(turn.id!) && typeof turn.program === "string");
    const fenceFree = raw.filter((turn) => !/^ {0,3}```/mu.test(turn.program!));
    const emitted = new Set(entries?.filter((entry) => entry.origin === "_plurnk" && entry.attrs?.kind === "emission").map((entry) => entry.turn_id));
    const noOperation = new Set(entries?.filter((entry) => entry.origin === "_plurnk" && entry.op === "error"
        && entry.inherited_history !== true && entry.ambient_event_id == null
        && entry.problem?.type === noOperationProblem && turnIds.has(entry.turn_id!)).map((entry) => entry.turn_id));
    const turns = attempted === undefined || attempted.some(({ turn_id }) => typeof turn_id !== "number") ? null : {
        modelTurns: turnIds.size,
        rawEmissions: raw.length,
        fenceFree: fenceFree.length,
        fenceFreeAdmitted: entries === undefined ? null : fenceFree.filter((turn) => emitted.has(turn.id)).length,
        noOperation: entries === undefined ? null : noOperation.size,
    };
    if (entries === undefined) return { turns, failures: null };
    const receipts = emptyReceipts();
    const streams = new Map<string, number>();
    let unaddressedExecutionReceipts = 0;
    for (const entry of entries) {
        if (typeof entry.status_rx !== "number" || entry.status_rx < 400) continue;
        const group = receipts[receiptOrigin(entry)];
        const op = entry.op ?? "?";
        group[op] = (group[op] ?? 0) + 1;
        if (entry.op !== "READ" || !entry.problem?.type?.startsWith(executorProblem)) continue;
        const path = typeof entry.target === "string" ? URL.parse(entry.target) : null;
        if (path === null) { unaddressedExecutionReceipts++; continue; }
        path.hash = "";
        streams.set(path.href, (streams.get(path.href) ?? 0) + 1);
    }
    return { turns, failures: { receipts, executionStreams: [...streams].map(([path, receipts]) => ({ path, receipts })), unaddressedExecutionReceipts } };
};

export interface FrictionSummary {
    turnTrials: number;
    failureTrials: number;
    turns: TurnFriction | null;
    receipts: ReceiptCounts | null;
    executionStreams: number | null;
    executionReceipts: number | null;
    unaddressedExecutionReceipts: number | null;
}

export const summarizeFriction = (items: readonly Friction[]): FrictionSummary => {
    const turns = items.flatMap((item) => item.turns === null ? [] : [item.turns]);
    const failures = items.flatMap((item) => item.failures === null ? [] : [item.failures]);
    const sum = (values: number[]): number => values.reduce((total, n) => total + n, 0);
    const complete = (values: Array<number | null>): number | null => values.some((n) => n === null) ? null : sum(values as number[]);
    const receipts = emptyReceipts();
    for (const failure of failures) for (const kind of Object.keys(receipts) as ReceiptOrigin[]) {
        for (const [op, n] of Object.entries(failure.receipts[kind])) receipts[kind][op] = (receipts[kind][op] ?? 0) + n;
    }
    return {
        turnTrials: turns.length,
        failureTrials: failures.length,
        turns: turns.length === 0 ? null : {
            modelTurns: sum(turns.map((turn) => turn.modelTurns)), rawEmissions: sum(turns.map((turn) => turn.rawEmissions)),
            fenceFree: sum(turns.map((turn) => turn.fenceFree)), fenceFreeAdmitted: complete(turns.map((turn) => turn.fenceFreeAdmitted)),
            noOperation: complete(turns.map((turn) => turn.noOperation)),
        },
        receipts: failures.length === 0 ? null : receipts,
        executionStreams: failures.length === 0 ? null : sum(failures.map((failure) => failure.executionStreams.length)),
        executionReceipts: failures.length === 0 ? null : sum(failures.flatMap((failure) => failure.executionStreams.map((stream) => stream.receipts))),
        unaddressedExecutionReceipts: failures.length === 0 ? null : sum(failures.map((failure) => failure.unaddressedExecutionReceipts)),
    };
};
