/**
 * Deterministic JSON serialization (keys sorted, `undefined` omitted, array order preserved).
 */
export function stableStringify(value: any): string {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value) ?? 'null';
    }
    if (Array.isArray(value)) {
        return `[${value.map(v => stableStringify(v)).join(',')}]`;
    }
    const keys = Object.keys(value)
        .filter(k => value[k] !== undefined)
        .sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Pairs the `{ update: { _id } }` and following `{ doc }` bulk operations produced for a product
 * into a map of document id to document.
 */
export function targetDocumentsById(
    operations: Array<{ operation: any }>,
): Map<string, unknown> {
    const byId = new Map<string, unknown>();
    for (let i = 0; i < operations.length - 1; i++) {
        const meta = operations[i].operation;
        const body = operations[i + 1].operation;
        if (meta?.update?._id != null && body?.doc) {
            byId.set(String(meta.update._id), body.doc);
            i++;
        }
    }
    return byId;
}

/**
 * True when the freshly-built documents (keyed by `_id`) match what is currently indexed, both in
 * the set of ids and in content.
 */
export function indexedDocumentsMatch(
    targetById: Map<string, unknown>,
    currentHits: Array<{ _id: string; _source: unknown }>,
): boolean {
    if (currentHits.length !== targetById.size) {
        return false;
    }
    for (const hit of currentHits) {
        if (!targetById.has(hit._id)) {
            return false;
        }
        if (stableStringify(targetById.get(hit._id)) !== stableStringify(hit._source)) {
            return false;
        }
    }
    return true;
}
