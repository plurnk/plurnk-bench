export const median = (values: readonly number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = values.toSorted((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
