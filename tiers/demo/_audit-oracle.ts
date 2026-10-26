export function hasAuditOutcome(answer: string): boolean {
    const listsFinding = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*)?\d+[.)](?:\*\*)?[ \t]+\S/u.test(answer);
    const explicitlyFindsNone = /\b(?:no|did not find any)\s+(?:material\s+)?(?:errors|issues|inconsistencies|ambiguities|findings)\b/i.test(answer);
    return listsFinding || explicitlyFindsNone;
}
