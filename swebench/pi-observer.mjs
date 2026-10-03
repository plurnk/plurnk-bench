// {§swebench-pi} Observation only: preserve native request/response bodies, never credentials.
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

export const pendingCaptures = new Set();

export function observeFetch(original, directory) {
    let sequence = 0;
    mkdirSync(directory, { recursive: true });
    return async (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (!url.pathname.endsWith("/chat/completions") && !url.pathname.endsWith("/messages")) return original(input, init);
        const id = String(++sequence).padStart(4, "0");
        const startedAt = new Date().toISOString();
        // Both SDKs send JSON strings. Refuse unobserved request shapes before spend.
        if (typeof init?.body !== "string") throw new Error("Pi request observer requires a JSON request body");
        writeFileSync(join(directory, `${id}.request.json`), init.body + "\n");
        try {
            const response = await original(input, init);
            writeFileSync(join(directory, `${id}.http.json`), JSON.stringify({
                startedAt, receivedAt: new Date().toISOString(), status: response.status,
                contentType: response.headers.get("content-type"),
            }) + "\n");
            const capture = pipeline(response.clone().body, createWriteStream(join(directory, `${id}.response.txt`)));
            pendingCaptures.add(capture);
            // Keep failures for the mandatory drain instead of causing an unhandled rejection.
            capture.catch((error) => writeFileSync(join(directory, `${id}.capture-error.json`), JSON.stringify({ message: String(error) }) + "\n"));
            return response;
        } catch (error) {
            writeFileSync(join(directory, `${id}.error.json`), JSON.stringify({ startedAt, message: String(error) }) + "\n");
            throw error;
        }
    };
}

export async function drainCaptures() {
    const captures = [...pendingCaptures];
    await Promise.all(captures);
    for (const capture of captures) pendingCaptures.delete(capture);
}
