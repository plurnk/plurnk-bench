#!/usr/bin/env node
import { existsSync } from "node:fs";

if (process.argv[2] === "models") {
    process.exit(existsSync(`${process.env.PLURNK_SERVICE_DB_PATH}.ready`) ? 0 : 1);
}
process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    members: process.env.PLURNK_MEMBERS_TASK ?? null,
    enabled: process.env.PLURNK_MEMBERS_ENABLED ?? null,
}));
if (process.env.TEST_CLIENT_EXIT !== undefined) process.exit(Number(process.env.TEST_CLIENT_EXIT));
setInterval(() => {}, 1000);
