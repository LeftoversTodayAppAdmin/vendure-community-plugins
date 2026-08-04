import { Logger } from '@vendure/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ElasticsearchService } from './elasticsearch.service';

interface MockAdapterHooks {
    /** Whether the live index already exists. */
    liveIndexExists?: boolean;
    onCreate?: (index: string) => void;
    onDelete?: (index: string) => void;
    onGetSettings?: (index: string) => void;
}

function createMockAdapter(hooks: MockAdapterHooks = {}) {
    const { liveIndexExists = true } = hooks;
    const created: string[] = [];
    const deleted: string[] = [];

    // Identical settings/mappings for both indices, so the drift check reports no
    // difference and walks the full comparison path.
    const settingsFor = (index: string) => ({
        [index]: { settings: { index: { analysis: { filter: {} }, uuid: 'ignored' } } },
    });
    const mappingsFor = (index: string) => ({
        [index]: { mappings: { properties: { sku: { type: 'text' } } } },
    });

    const adapter: any = {
        indices: {
            exists: vi.fn(() => Promise.resolve({ body: liveIndexExists })),
            create: vi.fn(({ index }: { index: string }) => {
                hooks.onCreate?.(index);
                created.push(index);
                return Promise.resolve({ body: {} });
            }),
            delete: vi.fn(({ index }: { index: string }) => {
                hooks.onDelete?.(index);
                deleted.push(index);
                return Promise.resolve({ body: {} });
            }),
            putAlias: vi.fn(() => Promise.resolve({ body: {} })),
            getSettings: vi.fn(({ index }: { index: string }) => {
                hooks.onGetSettings?.(index);
                return Promise.resolve({ body: settingsFor(index) });
            }),
            getMapping: vi.fn(({ index }: { index: string }) =>
                Promise.resolve({ body: mappingsFor(index) }),
            ),
        },
    };
    return { adapter, created, deleted };
}

function createService(adapter: any): ElasticsearchService {
    const options: any = {
        indexPrefix: 'test-',
        indexSettings: {},
        indexMappingProperties: {},
        adapter: () => adapter,
    };
    const service = new ElasticsearchService(
        options,
        { adopt: vi.fn() } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
    );
    service.onModuleInit();
    return service;
}

describe('ElasticsearchService.createIndicesIfNotExists()', () => {
    beforeEach(() => {
        vi.spyOn(Logger, 'verbose').mockImplementation(() => undefined);
        vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
        vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    });

    describe('when the live index does not exist', () => {
        it('does not abort bootstrap when the index cannot be created', async () => {
            const { adapter } = createMockAdapter({
                liveIndexExists: false,
                onCreate: () => {
                    throw new Error('Request timed out');
                },
            });
            const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
            const service = createService(adapter);

            await expect(service.createIndicesIfNotExists()).resolves.toBeUndefined();

            expect(errorSpy.mock.calls.some(([msg]) => msg.includes('Could not create index'))).toBe(
                true,
            );
        });
    });

    describe('when the live index exists (drift check)', () => {
        it('deletes the temporary index it created, using the name it was created with', async () => {
            const { adapter, created, deleted } = createMockAdapter();
            const service = createService(adapter);

            await service.createIndicesIfNotExists();

            expect(created).toHaveLength(1);
            expect(created[0]).toMatch(/^temp-\d+-[a-z0-9]+-variants$/);
            expect(deleted).toEqual([created[0]]);
        });

        it('deletes the temporary index when the drift check throws', async () => {
            const { adapter, created, deleted } = createMockAdapter({
                onGetSettings: index => {
                    if (index.startsWith('temp-')) {
                        throw new Error('index_not_found_exception');
                    }
                },
            });
            const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
            const service = createService(adapter);

            await expect(service.createIndicesIfNotExists()).resolves.toBeUndefined();

            expect(deleted).toEqual([created[0]]);
            expect(warnSpy.mock.calls.some(([msg]) => msg.includes('Could not compare index'))).toBe(
                true,
            );
        });

        it('still attempts the cleanup when creating the temporary index failed', async () => {
            const { adapter, created, deleted } = createMockAdapter({
                onCreate: () => {
                    throw new Error('Request timed out');
                },
            });
            const service = createService(adapter);

            await expect(service.createIndicesIfNotExists()).resolves.toBeUndefined();

            // A client-side timeout on the create does not prove the server did not
            // create the index, so the delete must still be attempted.
            expect(created).toEqual([]);
            expect(deleted).toHaveLength(1);
            expect(deleted[0]).toMatch(/^temp-\d+-[a-z0-9]+-variants$/);
        });

        it('does not let a failing cleanup mask the original error', async () => {
            const { adapter } = createMockAdapter({
                onGetSettings: index => {
                    if (index.startsWith('temp-')) {
                        throw new Error('index_not_found_exception');
                    }
                },
                onDelete: () => {
                    throw new Error('delete failed too');
                },
            });
            const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
            const service = createService(adapter);

            await expect(service.createIndicesIfNotExists()).resolves.toBeUndefined();

            const messages = warnSpy.mock.calls.map(([msg]) => msg);
            expect(messages.some(msg => msg.includes('Could not compare index'))).toBe(true);
            expect(messages.some(msg => msg.includes('Could not delete temporary index'))).toBe(true);
        });
    });
});
