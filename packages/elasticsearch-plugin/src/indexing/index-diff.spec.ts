import { describe, expect, it } from 'vitest';

import { indexedDocumentsMatch, stableStringify, targetDocumentsById } from './index-diff';

describe('stableStringify', () => {
    it('is independent of object key order', () => {
        expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    });

    it('is independent of key order in nested objects', () => {
        const x = { outer: { a: 1, b: { c: 3, d: 4 } } };
        const y = { outer: { b: { d: 4, c: 3 }, a: 1 } };
        expect(stableStringify(x)).toBe(stableStringify(y));
    });

    it('preserves array order (arrays are position-sensitive)', () => {
        expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
        expect(stableStringify(['a', 'b'])).toBe(stableStringify(['a', 'b']));
    });

    it('omits undefined values so they equal an absent key', () => {
        expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    });

    it('distinguishes null from absent/undefined', () => {
        expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
        expect(stableStringify(null)).toBe('null');
    });

    it('serializes primitives', () => {
        expect(stableStringify('x')).toBe('"x"');
        expect(stableStringify(42)).toBe('42');
        expect(stableStringify(true)).toBe('true');
    });

    it('distinguishes number from numeric string', () => {
        expect(stableStringify({ n: 2 })).not.toBe(stableStringify({ n: '2' }));
    });
});

describe('targetDocumentsById', () => {
    const update = (id: string) => ({ operation: { update: { _id: id } } });
    const doc = (d: unknown) => ({ operation: { doc: d, doc_as_upsert: true } });

    it('pairs each update op with the following doc op', () => {
        const ops = [update('1_10_en'), doc({ inStock: true }), update('1_11_en'), doc({ inStock: false })];
        const result = targetDocumentsById(ops);
        expect(result.size).toBe(2);
        expect(result.get('1_10_en')).toEqual({ inStock: true });
        expect(result.get('1_11_en')).toEqual({ inStock: false });
    });

    it('returns an empty map for no operations', () => {
        expect(targetDocumentsById([]).size).toBe(0);
    });

    it('ignores a trailing update op with no following doc', () => {
        const ops = [update('1_10_en'), doc({ inStock: true }), update('1_11_en')];
        const result = targetDocumentsById(ops);
        expect(result.size).toBe(1);
        expect(result.has('1_11_en')).toBe(false);
    });

    it('coerces numeric ids to strings', () => {
        const ops = [{ operation: { update: { _id: 5 } } }, doc({ inStock: true })];
        expect(targetDocumentsById(ops).has('5')).toBe(true);
    });
});

describe('indexedDocumentsMatch', () => {
    const target = new Map<string, unknown>([
        ['1_10_en', { inStock: true, productInStock: true, sku: 'A', facetIds: ['1', '2'] }],
        ['1_11_en', { inStock: false, productInStock: true, sku: 'B', facetIds: [] }],
    ]);

    it('returns true when ids and content match (ignoring key order)', () => {
        const hits = [
            // deliberately reordered keys in _source
            { _id: '1_11_en', _source: { facetIds: [], sku: 'B', productInStock: true, inStock: false } },
            { _id: '1_10_en', _source: { facetIds: ['1', '2'], sku: 'A', inStock: true, productInStock: true } },
        ];
        expect(indexedDocumentsMatch(target, hits)).toBe(true);
    });

    it('returns false when a document field differs (e.g. inStock flipped)', () => {
        const hits = [
            { _id: '1_10_en', _source: { inStock: false, productInStock: true, sku: 'A', facetIds: ['1', '2'] } },
            { _id: '1_11_en', _source: { inStock: false, productInStock: true, sku: 'B', facetIds: [] } },
        ];
        expect(indexedDocumentsMatch(target, hits)).toBe(false);
    });

    it('returns false when a stock-derived custom field differs (guards the onStockStatusChange caveat)', () => {
        const targetWithCustom = new Map<string, unknown>([
            ['1_10_en', { inStock: true, 'product-stockCount': 5 }],
        ]);
        const hits = [{ _id: '1_10_en', _source: { inStock: true, 'product-stockCount': 4 } }];
        expect(indexedDocumentsMatch(targetWithCustom, hits)).toBe(false);
    });

    it('returns false when the index has an extra document (removal needed)', () => {
        const hits = [
            { _id: '1_10_en', _source: { inStock: true, productInStock: true, sku: 'A', facetIds: ['1', '2'] } },
            { _id: '1_11_en', _source: { inStock: false, productInStock: true, sku: 'B', facetIds: [] } },
            { _id: '1_12_en', _source: { inStock: true, productInStock: true, sku: 'C', facetIds: [] } },
        ];
        expect(indexedDocumentsMatch(target, hits)).toBe(false);
    });

    it('returns false when a target document is missing from the index (needs creating)', () => {
        const hits = [
            { _id: '1_10_en', _source: { inStock: true, productInStock: true, sku: 'A', facetIds: ['1', '2'] } },
        ];
        expect(indexedDocumentsMatch(target, hits)).toBe(false);
    });

    it('returns false when an indexed id is not in the target set', () => {
        const hits = [
            { _id: '1_10_en', _source: { inStock: true, productInStock: true, sku: 'A', facetIds: ['1', '2'] } },
            { _id: '9_99_en', _source: { inStock: false, productInStock: true, sku: 'B', facetIds: [] } },
        ];
        expect(indexedDocumentsMatch(target, hits)).toBe(false);
    });
});
