// {§tier-corpus} {§tier-corpus}
import { liveTest as test } from "@plurnk/plurnk-service/harness";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FunctionalityListResult } from "@plurnk/plurnk-contracts";
import { liveLoop, liveWorkspace } from "@plurnk/plurnk-service/harness";
import { stdioEntry } from "@plurnk/plurnk-service/harness";
import { initializeDemoRepository } from "@plurnk/plurnk-service/harness";

test("demo: the model repairs a broken MCP file and uses its restored tool", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-demo-config-repair-"));
    const config = join(root, ".agents", "mcp.json");
    const definition = { mcpServers: { echo: stdioEntry("echo-server.mjs") } };
    const marker = `REPAIRED_${crypto.randomUUID()}`;
    await mkdir(join(root, ".agents"));
    await writeFile(config, JSON.stringify(definition, null, 2).slice(0, -1));
    initializeDemoRepository(root, "seed broken configuration fixture");
    const controls = { PLURNK_SERVICE_ROOTS: "project", PLURNK_MCP_ENABLED: "1" };
    const saved = Object.keys(controls).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, controls);
    t.after(async () => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await rm(root, { recursive: true, force: true });
    });
    const s = await liveWorkspace({ name: `demo-config-repair-${crypto.randomUUID()}`, projectRoot: root });
    try {
        const result = await liveLoop(s, 2, {
            prompt: `The project MCP configuration in .agents/mcp.json is broken. Repair that file, preserving its server definition. Then use the configured echo tool to echo ${marker}; report the tool reply and the winning configuration source. Do not add a workspace override.`,
            maxTurns: 12,
        }, { signal: t.signal });
        assert.equal(result.finalStatus, 200);
        assert.deepEqual(JSON.parse(await readFile(config, "utf8")), definition);
        const listed = await s.invokeWorkspaceAction("workspace.mcp.list", {}) as FunctionalityListResult;
        const effective = listed.definitions.find(({ alias }) => alias === "echo");
        assert.equal(effective?.state, "active");
        assert.equal(effective?.origin, "service");
        assert.deepEqual(effective?.provenance, { kind: "file", source: config, reference: "/mcpServers/echo" });
        const log = await s.daemon.readLog({ workspaceId: s.workspaceId, sessionId: result.modelSessionId, limit: Number.MAX_SAFE_INTEGER });
        assert.ok(log.some((row) => row.op === "READ" && row.scheme === "echo" && row.status_rx === 200 && JSON.stringify(row.rx).includes(marker)),
            "the model actually observes the restored tool output, not merely repeats the requested marker");
        assert.ok(result.lastContent.includes(marker));
        assert.match(result.lastContent, /mcp\.json/u);
    } finally { await s.cleanup(); }
});

test("demo: configured skill sources survive a model's workspace override and removal", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-demo-config-sources-"));
    const name = "source-review";
    const key = "PLURNK_SKILLS_source_review";
    const baseline = join(root, "configured", name);
    const replacement = join(root, "replacement", name);
    const markers = ["BASELINE_" + crypto.randomUUID(), "REPLACEMENT_" + crypto.randomUUID()];
    const documents = markers.map((marker) => `---\nname: ${name}\ndescription: Report this review skill's verification marker.\n---\nWhen asked to follow this skill, report the exact marker: ${marker}\n`);
    const saved = new Map([key, `${key}_ENABLED`].map((variable) => [variable, process.env[variable]]));
    t.after(async () => {
        for (const [variable, value] of saved) {
            if (value === undefined) delete process.env[variable];
            else process.env[variable] = value;
        }
        await rm(root, { recursive: true, force: true });
    });
    for (const [index, directory] of [baseline, replacement].entries()) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "SKILL.md"), documents[index]);
    }
    process.env[key] = JSON.stringify({ name, source: baseline });
    process.env[`${key}_ENABLED`] = "0";
    const s = await liveWorkspace({ name: `demo-config-sources-${crypto.randomUUID()}`, projectRoot: root });
    try {
        let sessionId: number | undefined;
        let requestId = 2;
        const run = async (prompt: string, marker: string) => {
            const result = await liveLoop(s, requestId++, { prompt, sessionId, maxTurns: 8 }, { signal: t.signal });
            sessionId = result.modelSessionId;
            assert.equal(result.finalStatus, 200, "the configuration request concludes cleanly");
            assert.ok(result.lastContent.includes(marker), "the answer contains the marker from the effective skill");
            return result.lastContent;
        };
        const effective = async () => {
            const listed = await s.invokeWorkspaceAction("workspace.skills.list", {}) as FunctionalityListResult;
            return listed.definitions.find(({ alias }) => alias === name);
        };
        await run(`An available skill named ${name} is disabled. Enable it for this workspace, follow its instructions, and report its verification marker.`, markers[0]);
        assert.equal((await effective())?.state, "active");
        assert.equal((await effective())?.origin, "service");
        await run(`For this workspace, replace ${name} with the local skill at ${replacement}. Follow the replacement and report its verification marker. Leave the replacement active until I ask you to remove it. Do not change either source folder.`, markers[1]);
        assert.equal((await effective())?.origin, "workspace");
        assert.deepEqual((await effective())?.definition, { name, source: replacement });
        const answer = await run(`Remove that workspace override so ${name} inherits its original configuration again. Leave the original skill enabled, follow it, and report both its verification marker and the configuration key supplying it. Do not modify configuration files or either source folder.`, markers[0]);
        assert.ok(answer.includes(key), "the model locates the winning input through ordinary inspection");
        assert.deepEqual(await effective(), {
            alias: name, origin: "service", state: "active", definition: { name, source: baseline },
            provenance: { kind: "environment", source: key },
            detail: { description: "Report this review skill's verification marker.", path: baseline },
        });
        for (const [index, directory] of [baseline, replacement].entries()) {
            assert.equal(await readFile(join(directory, "SKILL.md"), "utf8"), documents[index], "configuration mutations preserve source files");
        }
    } finally { await s.cleanup(); }
});
