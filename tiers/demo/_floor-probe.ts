// Measure a workspace's true turn-1 packet floor under its natural provider
// envelope. The measurement is the first stored request, not the loop's terminal
// disposition. Pressure tests derive their provider input-capacity target from
// THIS number, so teaching growth re-calibrates the pin instead of starting a
// razor-pin treadmill.

import { liveWorkspace, liveLoop } from "@plurnk/plurnk-service/harness";

export const measureFloor = async (opts: { signal: AbortSignal; label: string; projectRoot: string; prompt: string }): Promise<{
    weight: number;
    outputBudget: number;
}> => {
    const s = await liveWorkspace({ name: `floor-probe-${opts.label}-${crypto.randomUUID()}`, projectRoot: opts.projectRoot });
    try {
        const { turnIds } = await liveLoop(
            s,
            2,
            { prompt: opts.prompt, maxTurns: 1 },
            { signal: opts.signal },
        );
        if (turnIds.length !== 2) {
            throw new Error(`floor probe recorded ${turnIds.length} durable turns; expected initialization plus one model turn`);
        }
        const rows = await Promise.all(turnIds.map((id) =>
            s.db.test_get_turn.get<{ packet: string | null }>({ id })));
        if (rows[0]?.packet !== null || rows[1]?.packet == null) {
            throw new Error("floor probe did not record packetless initialization followed by one model turn");
        }
        const weight = (JSON.parse(rows[1].packet) as { weight?: number }).weight ?? 0;
        if (weight <= 0) throw new Error("floor probe read no packet weight from the first stored request");
        if (s.provider.outputBudget === null) throw new Error("floor probe provider has no resolved output budget");
        return { weight, outputBudget: s.provider.outputBudget };
    } finally { await s.cleanup(); }
};
