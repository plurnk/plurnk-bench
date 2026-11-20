// {§tier-corpus} — current third-party stdio and Streamable HTTP servers
// compose through the assembled daemon and its ACP listener: a scripted model, real servers.
// Kept in `tiers/network` outside paid real-model `live`/`demo` runs because `provider` is
// `PacketCapturingMock` (zero inference calls).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import {
    actionResult,
    bindListener,
    Daemon,
    httpEntry,
    liveTest as test,
    makeMockResponse,
    mcpFixture,
    openMigrated,
    packet,
    PacketCapturingMock,
    post,
    runInput,
    serverProposals,
    sessionUpdates,
    terminalMeta,
} from "@plurnk/plurnk-service/harness";

const GOJI = "https://mcp.goji.agency/mcp";
const KUBERNETES_SERVER = "kubernetes-mcp-server@0.0.66";

test("{§tier-corpus} network mcp: current third-party stdio and HTTP servers compose through the assembled product", {
    timeout: 120_000,
    requires: ["bin:npx", `url:${GOJI}`, "url:https://registry.npmjs.org/kubernetes-mcp-server"],
}, async (t) => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new PacketCapturingMock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse('plurnk.read({ path: "mcp:///kubernetes.md", range: "1,-1" })\nplurnk.note({ text: "Select the configuration tool linked from the runtime document." })'),
            makeMockResponse('plurnk.read({ path: "mcp:///kubernetes/configuration_view.json", range: "1,-1" })\nplurnk.note({ text: "Use the exact contract after reading it." })'),
            makeMockResponse('kubernetes.configuration_view({ minified: true })\nplurnk.note({ text: "Inspect the returned configuration." })'),
            makeMockResponse('plurnk.done({ text: "The current Kubernetes context is specimen." })'),
            makeMockResponse('plurnk.read({ path: "mcp:///goji.md", range: "1,-1" })\nplurnk.note({ text: "Select the terminology tool linked from the runtime document." })'),
            makeMockResponse('plurnk.read({ path: "mcp:///goji/goji_explain_term.json", range: "1,-1" })\nplurnk.note({ text: "Use the documented tool and resource." })'),
            makeMockResponse('goji.goji_explain_term({ term: "AEO" })\nplurnk.read({ path: "goji:///resources/goji%3A%2F%2Fabout" })\nplurnk.note({ text: "Inspect both remote results." })'),
            makeMockResponse('plurnk.done({ text: "GOJI answered the AEO query and served its about resource." })'),
        ],
    });
    const projectRoot = await mkdtemp(join(tmpdir(), "plurnk-mcp-third-party-"));
    const kubeconfig = join(projectRoot, "kubeconfig");
    await writeFile(kubeconfig, [
        "apiVersion: v1",
        "kind: Config",
        "clusters:",
        "  - name: unreachable",
        "    cluster:",
        "      server: http://127.0.0.1:9",
        "contexts:",
        "  - name: specimen",
        "    context:",
        "      cluster: unreachable",
        "      user: anonymous",
        "current-context: specimen",
        "users:",
        "  - name: anonymous",
        "    user: {}",
        "",
    ].join("\n"));
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, {
        kubernetes: {
            type: "stdio",
            command: "npx",
            args: ["--yes", KUBERNETES_SERVER, "--kubeconfig", kubeconfig, "--read-only", "--log-file", join(projectRoot, "kubernetes.log")],
        },
        goji: httpEntry(GOJI),
    });
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({
        db,
        provider,
        nodeModulesPath: join(process.cwd(), "../node_modules"),
        hostPaths,
        http,
    });
    daemon.registerModule(McpModule.init({
        env: {
            ...mcpEnv,
            PLURNK_MCP_CONNECT_TIMEOUT_MS: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT_MS: "30000",
            PLURNK_MCP_RETRY_FLOOR_MS: "250",
            PLURNK_MCP_RETRY_CEILING_MS: "5000",
            PLURNK_MCP_kubernetes_TOOLS: '["configuration_view"]',
            PLURNK_MCP_goji_TOOLS: '["goji_explain_term"]',
        },
    }), "@plurnk/plurnk-mcp");

    try {
        await daemon.start();
        const { port } = http.httpAddress();
        const workspace = `mcp-third-party-${crypto.randomUUID()}`;

        const kubernetes = actionResult(await post(port, runInput(workspace, "enable-kubernetes", {
            projectRoot,
            action: { kind: "workspace.mcp.enable", alias: "kubernetes" },
        })));
        assert.equal(kubernetes.ok, true, JSON.stringify(kubernetes.problem));
        const kubernetesSummary = kubernetes.result?.definition as { readonly detail?: { readonly tools?: readonly string[] } } | undefined;
        assert.ok((kubernetesSummary?.detail?.tools?.length ?? 0) > 1, "the real server advertises its full catalog");

        const goji = actionResult(await post(port, runInput(workspace, "enable-goji", {
            action: { kind: "workspace.mcp.enable", alias: "goji" },
        })));
        assert.equal(goji.ok, true, JSON.stringify(goji.problem));
        serverProposals(t, "accept");

        const kubernetesRun = await post(port, runInput(workspace, "call-kubernetes", {
            prompt: "Use the attached Kubernetes configuration tool and report the current context.",
        }));
        assert.equal(terminalMeta(kubernetesRun)?.stopReason, "end_turn");
        const anyPacket = (pattern: RegExp): boolean => provider.requests.some((_, index) => pattern.test(packet(provider.requests, index)));
        assert.ok(anyPacket(/mcp:\/\/\/kubernetes\.md/), "the survey listed the Kubernetes runtime document");
        assert.ok(anyPacket(/mcp:\/\/\/goji\.md/), "the survey listed the GOJI runtime document");
        assert.ok(anyPacket(/current-context: specimen/), "the real server's kubeconfig reached the model");

        const gojiRun = await post(port, runInput(workspace, "call-goji", {
            prompt: "Ask GOJI to explain AEO and read its about resource.",
        }));
        assert.equal(terminalMeta(gojiRun)?.stopReason, "end_turn");
        assert.ok(anyPacket(/AEO/i), "GOJI's tool result reached the model");
        assert.ok(anyPacket(/goji:\/\/\/resources\/goji%3A%2F%2Fabout/), "GOJI's about resource receipt reached the model");
        const speech = sessionUpdates(gojiRun)
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => ((u.content as { text?: string } | undefined)?.text ?? ""))
            .join("");
        assert.match(speech, /GOJI answered the AEO query/);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(projectRoot, { recursive: true, force: true });
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});
