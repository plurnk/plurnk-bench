// {§tier-corpus} {§tier-corpus} — current third-party stdio and Streamable HTTP servers
// compose through the assembled daemon and its ACP listener: a scripted model, real servers. The
// specimen names what it needs of the host (npx, the registry that serves the stdio server, the
// remote HTTP server) and skips by name when one does not answer.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import { Daemon } from "@plurnk/plurnk-service/harness";
import { serverProposals } from "@plurnk/plurnk-service/harness";
import { bindListener } from "@plurnk/plurnk-service/harness";
import { openMigrated } from "@plurnk/plurnk-service/harness";
import { makeMockResponse } from "@plurnk/plurnk-service/harness";
import { httpEntry, mcpFixture } from "@plurnk/plurnk-service/harness";
import { actionResult, packet, PacketCapturingMock, post, runInput, sessionUpdates, terminalMeta } from "@plurnk/plurnk-service/harness";

const GOJI = "https://mcp.goji.agency/mcp";
const KUBERNETES_SERVER = "kubernetes-mcp-server@0.0.66";

test("live mcp: current third-party stdio and HTTP servers compose through the assembled product", {
    timeout: 120_000,
    requires: ["bin:npx", `url:${GOJI}`, "url:https://registry.npmjs.org/kubernetes-mcp-server"],
}, async (t) => {
    const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const provider = new PacketCapturingMock({
        contextWindow: 1_000_000,
        responses: [
            makeMockResponse("\n````READ (mcp:///kubernetes.md) <1,-1>````\n````NOTE\nSelect the configuration tool linked from the runtime document.\n````"),
            makeMockResponse("\n````READ (mcp:///kubernetes/configuration_view.json) <1,-1>````\n````NOTE\nUse the exact contract after reading it.\n````"),
            makeMockResponse("\n````kubernetes (configuration_view)\n{\"minified\":true}\n````\n\n````NOTE\nInspect the returned configuration.\n````"),
            makeMockResponse("````SEND [200]\nThe current Kubernetes context is specimen.\n````"),
            makeMockResponse("\n````READ (mcp:///goji.md) <1,-1>````\n````NOTE\nSelect the terminology tool linked from the runtime document.\n````"),
            makeMockResponse("\n````READ (mcp:///goji/goji_explain_term.json) <1,-1>````\n````NOTE\nUse the documented tool and resource.\n````"),
            makeMockResponse("\n````goji (goji_explain_term)\n{\"term\":\"AEO\"}\n````\n\n````READ (goji:///resources/goji%3A%2F%2Fabout)````\n````NOTE\nInspect both remote results.\n````"),
            makeMockResponse("````SEND [200]\nGOJI defines AEO as Answer Engine Optimisation and identifies itself as a Melbourne digital agency.\n````"),
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
    // {§tier-corpus}
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
            PLURNK_MCP_CONNECT_TIMEOUT: "30000",
            PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
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
        assert.equal(kubernetesSummary?.detail?.tools?.length, 14, "the real server advertises a larger catalog");

        const goji = actionResult(await post(port, runInput(workspace, "enable-goji", {
            action: { kind: "workspace.mcp.enable", alias: "goji" },
        })));
        assert.equal(goji.ok, true, JSON.stringify(goji.problem));
        // {§tier-corpus} These third-party tools may omit readOnlyHint.
        serverProposals(t, "accept");

        const kubernetesRun = await post(port, runInput(workspace, "call-kubernetes", {
            prompt: "Use the attached Kubernetes configuration tool and report the current context.",
        }));
        assert.equal(terminalMeta(kubernetesRun)?.stopReason, "end_turn");
        // {§tier-corpus} is witnessed shape by shape in the intg tier under the Mock profile;
        // this specimen witnesses the composition: the real server's catalog, its tool's result in a
        // packet, the run's outcome and the model's speech.
        const anyPacket = (pattern: RegExp): boolean => provider.requests.some((_, index) => pattern.test(packet(provider.requests, index)));
        assert.ok(anyPacket(/mcp:\/\/\/kubernetes\.md/), "the survey listed the Kubernetes runtime document");
        assert.ok(anyPacket(/mcp:\/\/\/goji\.md/), "the survey listed the GOJI runtime document");
        assert.ok(anyPacket(/current-context: specimen/), "the real server's kubeconfig reached the model");

        const gojiRun = await post(port, runInput(workspace, "call-goji", {
            prompt: "Ask GOJI to explain AEO and read its about resource.",
        }));
        assert.equal(terminalMeta(gojiRun)?.stopReason, "end_turn");
        assert.ok(anyPacket(/Answer Engine Optimisation/), "GOJI's tool result reached the model");
        assert.ok(anyPacket(/Melbourne-based full-service digital agency/), "GOJI's about resource reached the model");
        const speech = sessionUpdates(gojiRun)
            .filter((u) => u.sessionUpdate === "agent_message_chunk")
            .map((u) => ((u.content as { text?: string } | undefined)?.text ?? ""))
            .join("");
        assert.match(speech, /GOJI defines AEO as Answer Engine Optimisation/);
    } finally {
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(projectRoot, { recursive: true, force: true });
        if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
    }
});
