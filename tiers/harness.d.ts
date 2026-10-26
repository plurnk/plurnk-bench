import type { TestContext, TestOptions } from "node:test";
import type { CapabilityPolicy, OperationResult, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Provider, ProviderResponse } from "@plurnk/plurnk-providers";

export type InputModality = "image" | "pdf" | "audio" | "video";
export type SiblingCheckout = "client";
export type LiveRequirement =
    | `input:${InputModality}`
    | "reasoning"
    | "output-budget"
    | `env:${string}`
    | `url:${string}`
    | `bin:${string}`
    | `checkout:${SiblingCheckout}`;

export interface RouteFacts {
    readonly inputModalities: ReadonlySet<string>;
    readonly supportedEfforts: readonly string[];
    readonly outputBudget: number | null;
}

export type ParsedRequirement =
    | { kind: "input"; modality: InputModality }
    | { kind: "reasoning" }
    | { kind: "output-budget" }
    | { kind: "env"; name: string }
    | { kind: "url"; url: string }
    | { kind: "bin"; name: string }
    | { kind: "checkout"; name: SiblingCheckout };

export interface HostProbes {
    readonly url: (url: string) => Promise<boolean>;
    readonly bin: (name: string) => boolean;
    readonly checkout: (name: SiblingCheckout, env: NodeJS.ProcessEnv) => string;
}

export interface LiveSpecimen {
    readonly name: string;
    readonly requires: readonly LiveRequirement[];
}

export interface LiveTestOptions extends TestOptions {
    readonly requires?: readonly LiveRequirement[];
}

export type LiveBody = (context: TestContext) => void | Promise<void>;

export interface LiveTestFn {
    (name: string, body: LiveBody): Promise<void>;
    (name: string, options: LiveTestOptions, body: LiveBody): Promise<void>;
}

export interface SqlStatement {
    get<T = Record<string, unknown>>(params?: Record<string, unknown>): Promise<T | undefined>;
    all<T = Record<string, unknown>>(params?: Record<string, unknown>): Promise<T[]>;
    run(params?: Record<string, unknown>): Promise<unknown>;
}

export interface Db {
    close(): Promise<void>;
    [statement: string]: SqlStatement & (() => Promise<void>);
}

export interface Daemon {
    readonly credentials: {
        issue(options: Record<string, unknown>): { token: string };
    };
    start(): Promise<void>;
    stop(): Promise<void>;
    registerModule(module: unknown, name?: string): void;
    settleFunctionality(workspaceId: number): Promise<void>;
    readLog(params: { workspaceId: number; sessionId: number; limit?: number }): Promise<Array<Record<string, unknown>>>;
    listSessions(workspaceId: number): Promise<Array<{ id: number; name: string; parentSessionId: number | null; origin: string }>>;
    readWorkspaceCapabilities(params: { workspaceId: number }): Promise<{ policy: CapabilityPolicy; effective: Record<string, unknown> }>;
    setWorkspaceCapabilities(params: { workspaceId: number; policy: CapabilityPolicy }): Promise<unknown>;
    dispatchClientAction(params: {
        workspaceId: number;
        actor: string;
        contextSessionId?: number;
        statements: readonly PlurnkStatement[];
    }): Promise<OperationResult[]>;
    invokeModuleAction(
        name: string,
        params: Readonly<Record<string, unknown>>,
        scope:
            | { scope: "workspace"; workspaceId: number }
            | { scope: "session"; workspaceId: number; sessionId: number }
            | { scope: "daemon" },
    ): Promise<unknown>;
    subscribeToEvents(listener: (workspaceId: number | null, method: string, params: unknown) => void): () => void;
}

export declare const Daemon: {
    new (options: {
        db: Db;
        provider?: Provider | null;
        mimetypes?: unknown;
        schemes?: SchemeRegistry;
        nodeModulesPath?: string;
        hostPaths?: unknown;
        http?: HttpListener | null;
    }): Daemon;
};

export interface SchemeRegistry {
    discoverExternal(cwd?: string): Promise<void>;
    close(): Promise<void>;
}

export declare const SchemeRegistry: {
    new (): SchemeRegistry;
};

export interface Engine {
    dispatch(params: {
        statement: PlurnkStatement;
        workspaceId: number;
        sessionId: number;
        loopId: number;
        turnId: number;
        sequence: number;
        origin: "model" | "client" | "_plurnk";
    }): Promise<OperationResult>;
}

export declare const Engine: {
    new (options: { db: Db; schemes: SchemeRegistry; mimetypes?: unknown }): Engine;
};

export interface HttpListener {
    httpAddress(): { host: string; port: number };
    close(): Promise<void>;
}

export interface LiveRun {
    readonly runDir: string;
    readonly dbPath: string;
    readonly hostPaths: unknown;
    finish(): void;
}

export interface LiveWorkspace {
    daemon: Daemon;
    db: Db;
    ws: unknown;
    provider: Provider;
    workspaceId: number;
    runDir: string;
    invokeWorkspaceAction: (name: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
    cleanup: () => Promise<void>;
}

export interface SessionCensus {
    readonly specimen: string | null;
    readonly label: string;
    readonly runDir: string;
    readonly loops: number;
    readonly turns: number;
    readonly requests: number;
    readonly tokens: { readonly input: number; readonly output: number };
    readonly cost: { readonly usd: number; readonly kinds: readonly string[] };
}

export declare const liveTest: LiveTestFn;
export declare const liveTimeoutMs: () => number;
export declare const currentSpecimen: () => LiveSpecimen | undefined;
export declare const collectLiveSpecimens: (files: readonly string[]) => Promise<readonly LiveSpecimen[]>;
export declare const collectLiveTestNames: (files: readonly string[]) => Promise<readonly string[]>;

export declare const parseRequirement: (requirement: string) => ParsedRequirement;
export declare const unmetRequirements: (
    requirements: readonly LiveRequirement[],
    facts: () => Promise<RouteFacts>,
    env?: NodeJS.ProcessEnv,
    probes?: HostProbes,
) => Promise<string[]>;
export declare const needsRoute: (requirements: readonly LiveRequirement[]) => boolean;
export declare const aliasesSatisfying: (
    requirement: LiveRequirement,
    aliases: readonly { readonly alias: string; readonly provider: string; readonly model: string }[],
) => string[] | null;
export declare const requirementsOfSkip: (reason: string) => LiveRequirement[];
export declare const checkoutPath: (name: SiblingCheckout, env?: NodeJS.ProcessEnv) => string;
export declare const checkoutKnob: (name: SiblingCheckout) => string;
export declare const onPath: (name: string, path?: string) => boolean;
export declare const reachable: (url: string) => Promise<boolean>;
export declare const HOST_PROBES: HostProbes;

export declare const liveProvider: () => Promise<Provider>;
export declare const liveRun: (name: string, opts?: { database?: boolean }) => Promise<LiveRun>;
export declare const liveWorkspace: (opts: { name: string; projectRoot?: string }) => Promise<LiveWorkspace>;
export declare const liveLoop: (
    s: { ws: unknown; db: Db },
    id: number,
    params: { prompt: string; sessionId?: number; maxTurns?: number; openPaths?: string[] },
    opts?: { timeoutMs?: number; signal?: AbortSignal },
) => Promise<{
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds: number[];
    modelSessionId: number;
    loopId: number;
    lastContent: string;
}>;
export declare const seedEntry: (
    db: Db,
    workspaceId: number,
    opts: { scheme?: string; pathname: string; content: string; mimetype?: string },
) => Promise<number>;
export declare const readBody: (db: Db, pathname: string) => Promise<string | undefined>;
export declare const lastRx: (db: Db, modelSessionId: number, op: string) => Promise<string>;
export declare const pinAliasInputCapacity: (opts: { inputCapacity: number; outputBudget: number }) => () => void;
export declare const failAfterCleanup: (primary: unknown, cleanup: () => Promise<void>) => Promise<never>;

export interface ResourceStateViolation {
    invariant: string;
    detail: string;
}
export declare const ResourceState: {
    check(db: Db): Promise<ResourceStateViolation[]>;
    entryCount(db: Db): Promise<number>;
};

export declare const openMigrated: (atPath?: string, opts?: { readers?: number }) => Promise<Db>;
export declare const insertWorkspace: (db: Db, name: string) => Promise<number>;
export declare const insertSession: (db: Db, workspaceId: number, parentSessionId?: number | null, name?: string, origin?: "model" | "_plurnk") => Promise<number>;
export declare const insertLoop: (db: Db, sessionId: number, sequence: number, prompt?: string) => Promise<number>;
export declare const insertTurn: (db: Db, loopId: number, sequence: number, status?: number) => Promise<number>;
export declare const bindListener: () => Promise<HttpListener>;
export declare const serverProposals: (t: TestContext, mode: "accept" | "reject" | "defer") => void;
export declare const TEST_OWNER: string;
export declare const rpcCall: (ws: unknown, id: number, method: string, params?: object) => Promise<{ jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } }>;
export declare const waitFor: <T>(getter: () => T[], predicate: (items: T[]) => boolean, opts?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal }) => Promise<T[]>;
export declare const waitForDb: <T>(getter: () => Promise<T>, predicate: (value: T) => boolean, opts?: { timeoutMs?: number; intervalMs?: number }) => Promise<T>;
export declare const namedModelSession: (daemon: Daemon, workspaceId: number, name: string) => Promise<number>;
export declare const readSessionTopology: (db: Db, workspaceId: number) => Promise<{
    sessions: Array<{ id: number; name: string; parent_session_id: number | null; origin: string }>;
    delegatedSessions: number;
    loops: Array<{ id: number; session_id: number; status: number }>;
    messages: Array<{ id: number; loop_id: number; source: string | null; body: string }>;
}>;
export declare const DEFAULT_MIMETYPES: unknown;
export declare const makeMockResponse: (content: string, outputTokens?: number) => ProviderResponse;
export declare const fixtureExecutors: (source: string) => readonly string[];
export declare const httpEntry: (url: string, headers?: Readonly<Record<string, string>>) => object;
export declare const stdioEntry: (file: string, env?: Readonly<Record<string, string>>) => object;
export declare const mcpFixture: (t: TestContext, servers: Readonly<Record<string, object>>) => Promise<{ hostPaths: unknown; env: Record<string, string> }>;

export interface PacketCapturingMock extends Provider {
    readonly requests: Array<{ messages: Array<{ role: string; content: unknown }> }>;
}
export declare const PacketCapturingMock: {
    new (options: { contextWindow: number; responses: ProviderResponse[] }): PacketCapturingMock;
};
export declare const packet: (requests: ReadonlyArray<{ messages: Array<{ role: string; content: unknown }> }>, index: number) => string;
export declare const runInput: (workspace: string, threadId: string, body: Record<string, unknown>) => Record<string, unknown>;
export declare const post: (port: number, body: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
export declare const actionResult: (frames: ReadonlyArray<Record<string, unknown>>) => { ok: boolean; result?: Record<string, unknown>; problem?: unknown };
export declare const terminalMeta: (frames: ReadonlyArray<Record<string, unknown>>) => { stopReason?: string } | undefined;
export declare const sessionUpdates: (frames: ReadonlyArray<Record<string, unknown>>) => Array<Record<string, unknown>>;

export declare const LogEntryProjection: {
    visibleBody(row: { op: string | null; rx: string; folded?: string; active: number }): string | null;
    isEmission(row: { origin?: string; op?: string | null; attrs?: unknown }): boolean;
    isReasoning(row: { origin?: string; op?: string | null; attrs?: unknown }): boolean;
};
export interface StoredAttachment {
    readonly coordinate: string;
    readonly contentHash: string;
    readonly mediaType?: string;
    readonly byteLength?: number;
}
export declare const StoredPacket: {
    parse(raw: string | null): {
        messages?: Array<{ role: string; content: unknown }>;
        attachments?: readonly StoredAttachment[];
    } | null;
};
export declare const RESULT_EXCEEDS_BUDGET: string;
export declare const hermeticGitEnv: (trustedRoot?: string) => NodeJS.ProcessEnv;

export interface DemoFixture {
    workspace: string;
    cleanup: () => Promise<void>;
    addToCatalog: (db: Db, workspaceId: number) => Promise<void>;
}
export declare const seedDemoFixture: (label: string) => Promise<DemoFixture>;
export declare const initializeDemoRepository: (workspace: string, message: string, trackAll?: boolean) => void;

export interface AttachmentFixture {
    readonly workspace: string;
    readonly answer: string;
    readonly content: string;
    readonly telemetry: string;
    readonly prompt: string;
    readonly openPaths: string[];
    readonly cleanup: () => Promise<void>;
}
export declare const seedAttachmentFixture: () => Promise<AttachmentFixture>;
export declare const assertContextFitEvidence: (args: {
    db: Db;
    daemon: Daemon;
    workspaceId: number;
    sessionId: number;
    turnIds: number[];
    fixture: AttachmentFixture;
}) => Promise<{ landed: number; receipts: number; modelTurns: number; receiptActive: boolean }>;

export declare const buildPdf: (options?: { title?: string; lines?: readonly string[] } | readonly string[]) => Uint8Array;
export declare const wav: (options?: { durationSeconds?: number; frequencyHz?: number; sampleRate?: number }) => Uint8Array;
export declare const serveMcpHttp: (t: TestContext, handler: unknown) => Promise<{ url: string; close: () => Promise<void> }>;
export declare const serveOAuthMcp: (
    t: TestContext,
    handler: unknown,
    options?: { code?: string },
) => Promise<{ served: { url: string; close: () => Promise<void> }; issuer: string }>;
