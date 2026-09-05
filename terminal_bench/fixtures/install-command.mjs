#!/usr/bin/env node
import { basename } from "node:path";

const command = `${basename(process.argv[1])} ${process.argv.slice(2).join(" ")}`;
if (command.startsWith("curl ")) {
    // The NodeSource response is executable shell, not an ordinary CLI message.
    process.stdout.write("printf 'fixture node repository configured\\n'\n");
} else {
    process.stdout.write(`${command} stdout\n`);
    process.stderr.write(`${command} stderr\n`);
    if (command === "apt-get update") {
        if (process.env.TEST_SETUP_FAIL === "1") process.exitCode = 7;
        if (process.env.TEST_SETUP_HANG === "1") setInterval(() => {}, 1_000);
    }
}
