#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";

if (process.env.TEST_BOOT_FAIL === "1") process.exit(7);
const path = process.env.PLURNK_SERVICE_DB_PATH;
const db = new DatabaseSync(path);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE evidence (body TEXT); INSERT INTO evidence VALUES ('committed before termination');");
writeFileSync(`${path}.ready`, "ready");
setInterval(() => {}, 1000);
const stop = () => { db.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
