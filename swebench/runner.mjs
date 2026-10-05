// Runs from the installed read-only bundle INSIDE the task container.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidence = "/var/lib/plurnk";
const dbPath = join(evidence, "plurnk.db");
const pidPath = join(evidence, "runner.pid");
mkdirSync(process.env.HOME, { recursive: true });
writeFileSync(pidPath, String(process.pid));
let child;
let daemon;
let interrupted = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => {
    interrupted = true;
    child?.kill("SIGTERM");
});
const binary = (name, bin) => {
    const path = fileURLToPath(import.meta.resolve(`${name}/package.json`));
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    return resolve(dirname(path), typeof manifest.bin === "string" ? manifest.bin : manifest.bin[bin]);
};
const invoke = async (file, args, prefix, env) => {
    const stdout = openSync(join(evidence, `${prefix}.stdout.${prefix === "pi" ? "jsonl" : "log"}`), "w");
    const stderr = openSync(join(evidence, `${prefix}.stderr.log`), "w");
    try {
        child = spawn(process.execPath, [file, ...args], { cwd: "/testbed", env, stdio: ["ignore", stdout, stderr] });
        if (interrupted) child.kill("SIGTERM");
        return await new Promise((accept, reject) => {
            child.once("error", reject);
            child.once("close", (status) => accept(status ?? 143));
        });
    } finally { closeSync(stdout); closeSync(stderr); }
};

try {
    const [kind, ...args] = process.argv.slice(2);
    if (args.includes("--preflight")) {
        const result = spawnSync("python", ["-c", 'import sys; assert sys.stdin.read() == "café ✓\\n"; assert sys.prefix.endswith("/envs/testbed"), sys.prefix; print(sys.executable); print("Unicode ✓")'],
            { input: "café ✓\n", encoding: "utf8" });
        if (result.status !== 0) throw new Error(`Task Python preflight failed: ${result.stderr}`, { cause: result.error });
        const probe = "/testbed/.harness-preflight";
        writeFileSync(probe, "Unicode ✓");
        const shell = spawnSync("sh", ["-c", 'test "$PWD" = /testbed && cat .harness-preflight'], { encoding: "utf8" });
        rmSync(probe);
        if (shell.status !== 0 || shell.stdout !== "Unicode ✓") throw new Error("Shell and native files disagree");
        writeFileSync(join(evidence, "preflight.json"), JSON.stringify({ node: process.version, cwd: process.cwd(), python: result.stdout, shell: shell.stdout }, null, 2) + "\n");
    } else if (kind === "plurnk") {
        const { default: Launch } = await import("@plurnk/plurnk-service/launch");
        daemon = await Launch.start({
            command: [process.execPath, `--env-file=${join(import.meta.dirname, ".env.test")}`, binary("@plurnk/plurnk-service", "plurnk-service"), "start"],
            cwd: "/testbed", env: { ...process.env, PLURNK_SERVICE_DB_PATH: dbPath },
            host: "127.0.0.1", port: 0, readyTimeoutMs: 30000, stopGraceMs: 5000,
            onOutput: (_stream, chunk) => process.stderr.write(chunk),
        });
        process.exitCode = await invoke(binary("@plurnk/plurnk", "plurnk"), args, "plurnk",
            { ...process.env, PLURNK_HOST: daemon.host, PLURNK_PORT: String(daemon.port) });
    } else if (kind === "pi") {
        process.exitCode = await invoke(join(import.meta.dirname, "node_modules/.bin/pi"), args, "pi", process.env);
    } else throw new Error(`Unknown candidate: ${kind}`);
} finally {
    try {
        if (daemon) {
            await daemon.stop();
            const { default: Share } = await import("@plurnk/plurnk-service/share");
            await Share.write({ dbPath, folder: join(evidence, "digest") });
        }
    } finally { rmSync(pidPath); }
}
