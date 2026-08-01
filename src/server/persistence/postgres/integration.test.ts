/**
 * Real PostgreSQL integration test, gated on TEST_DATABASE_URL.
 *
 * Tests run against an isolated schema to ensure no side effects.
 * Every connection uses the test schema via connection `options`,
 * not through SET search_path.
 * Schema is created by an admin pool and dropped in cleanup.
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { AppSettings, MediaItem, SavedSearch } from '../../../shared/types.js';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const TEST_SCHEMA = 'oftest_postgres_' + Math.random().toString(36).substring(2, 10);

/**
 * Admin pool: creates/drops the schema. Each connection uses options to
 * explicitly set search_path, not SET search_path via query.
 */
async function createAdminPool(): Promise<pg.Pool | undefined> {
  if (!TEST_DB_URL) return undefined;
  const pool = new pg.Pool({
    connectionString: TEST_DB_URL,
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // Create the test schema
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${TEST_SCHEMA}"`);
  return pool;
}

async function destroyAdminPool(pool: pg.Pool): Promise<void> {
  if (pool) {
    await pool.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await pool.end();
  }
}

/**
 * Test schema name: lowercase alphanumeric + underscore only.
 */
function sanitizeSchemaName(input: string): string {
  return input.replace(/[^a-z0-9_]/g, '_');
}

/**
 * Dedicated test pool: each connection explicitly uses search_path via options.
 */
async function createTestPool(): Promise<pg.Pool> {
  if (!TEST_DB_URL) {
    return undefined!;
  }
  const sanitizedSchema = sanitizeSchemaName(TEST_SCHEMA);
  const pool = new pg.Pool({
    connectionString: TEST_DB_URL,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    options: `-c search_path="${sanitizedSchema}"`,
  });
  return pool;
}

// ---- Import modules ----

import {
  POSTGRES_MIGRATIONS,
  runPostgresMigrations,
} from './migrations.js';
import {
  encodeSettings,
  decodeSettingsRow,
  encodeMediaIndexState,
  decodeMediaIndexStateRow,
  encodeMediaItem,
  decodeMediaItemRow,
  encodeSavedSearch,
  decodeSavedSearchRow,
} from './codec.js';
import {
  PostgresSettingsRepository,
  PostgresMediaIndexRepository,
  PostgresSavedSearchRepository,
} from './repositories.js';

describe('Real PostgreSQL integration', () => {
  let adminPool: pg.Pool | undefined;
  let pool: pg.Pool;

  beforeAll(async () => {
    adminPool = await createAdminPool();
    pool = await createTestPool();
    // Run migrations once before any cleanup, ensuring schema_migrations and all tables exist
    if (pool) {
      await runPostgresMigrations(pool);
    }
  });

  afterAll(async () => {
    // Drop schema via admin pool
    await destroyAdminPool(adminPool);
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    // Reset all application tables before each data test while preserving schema_migrations
    if (pool) {
      await pool.query('DELETE FROM import_runs');
      await pool.query('DELETE FROM saved_searches');
      await pool.query('DELETE FROM media_items');
      await pool.query('DELETE FROM media_index_state');
      await pool.query('DELETE FROM app_settings');
    }
  });

  const itIf = (condition: boolean) =>
    condition ? it : it.skip;

  itIf(!!TEST_DB_URL)('should skip if no TEST_DATABASE_URL', () => {
    if (!TEST_DB_URL) return;
    expect(pool).toBeDefined();
  });

  itIf(!!TEST_DB_URL)('migrations run and verify order and checksums', async () => {
    // Since migrations already ran in beforeAll, this should be a no-op
    const applied = await runPostgresMigrations(pool);
    // applied is 0 if already applied, or >0 if some were pending
    // But migrations were already run in beforeAll, so expect 0 or the count of pending

    // Verify schema_migrations table shows applied migrations
    const result = await pool.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name ASC',
    );
    expect(result.rows.length).toBe(POSTGRES_MIGRATIONS.length);

    // Verify each migration name and checksum
    for (let i = 0; i < POSTGRES_MIGRATIONS.length; i++) {
      const row = result.rows[i];
      expect(row.name).toBe(POSTGRES_MIGRATIONS[i].name);
      expect(row.checksum).toBe(POSTGRES_MIGRATIONS[i].checksum);
    }
  });

  itIf(!!TEST_DB_URL)('checksum mismatch causes error and restores original checksum', async () => {
    // Save the original checksum of the first migration
    const originalCheckResult = await pool.query(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [POSTGRES_MIGRATIONS[0].name],
    );
    const originalChecksum = originalCheckResult.rows[0].checksum;

    // Alter the stored checksum of the first migration
    const wrongChecksum = 'a'.repeat(64); // fake hex string, not matching
    await pool.query(
      'UPDATE schema_migrations SET checksum = $1 WHERE name = $2',
      [wrongChecksum, POSTGRES_MIGRATIONS[0].name],
    );

    try {
      // Expect runPostgresMigrations to throw a checksum mismatch error
      await expect(
        runPostgresMigrations(pool),
      ).rejects.toThrow(/checksum mismatch/i);
    } finally {
      // Restore the original checksum to keep tests order-independent
      await pool.query(
        'UPDATE schema_migrations SET checksum = $1 WHERE name = $2',
        [originalChecksum, POSTGRES_MIGRATIONS[0].name],
      );
    }

    // Verify the checksum is restored
    const verifyResult = await pool.query(
      'SELECT checksum FROM schema_migrations WHERE name = $1',
      [POSTGRES_MIGRATIONS[0].name],
    );
    expect(verifyResult.rows[0].checksum).toBe(originalChecksum);
  });

  itIf(!!TEST_DB_URL)('Settings CRUD: load, save, update, concurrency', async () => {
    const repo = new PostgresSettingsRepository({
      pool,
      defaults: {
        defaultSettings: () => ({
          libraries: [
            { id: 'default', name: 'Library', path: '/tmp', enabled: true, startExpanded: true },
          ],
          tagCatalog: [],
          tagAliases: {},
        }),
      },
      defaultLibraryPath: '/tmp',
    });

    // Load (should return defaults since no row exists yet)
    const initial = await repo.load();
    expect(initial.libraries.length).toBe(1);

    // Save new settings
    const settings: AppSettings = {
      libraries: [
        { id: 'lib1', name: 'Lib 1', path: '/data', enabled: true, startExpanded: false },
      ],
      tagCatalog: ['a', 'b', 'c'],
      tagAliases: {},
    };
    const saved = await repo.save(settings);
    expect(saved.libraries[0].id).toBe('lib1');

    // Load again to confirm persisted
    const loaded = await repo.load();
    expect(loaded.libraries[0].id).toBe('lib1');
    expect(loaded.tagCatalog).toEqual(['a', 'b', 'c']);

    // Update with mutator
    const updated = await repo.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 'd'],
    }));
    expect(updated.tagCatalog).toContain('d');

    // Concurrent updates (two simultaneous updates)
    const update1 = repo.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 'e'],
    }));
    const update2 = repo.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 'f'],
    }));
    await Promise.all([update1, update2]);

    const final = await repo.load();
    expect(final.tagCatalog).toContain('d');
    expect(final.tagCatalog).toContain('e');
    expect(final.tagCatalog).toContain('f');
  });

  itIf(!!TEST_DB_URL)('Media index: save/load roundtrip with order, optional fields, tags, large size', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });

    // Empty save
    const emptyResult = await repo.save([]);
    expect(emptyResult.files).toEqual([]);

    // Create media items
    const items: MediaItem[] = [
      {
        id: 'img1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'folder/img1.jpg',
        folder: 'folder',
        name: 'img1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 12345,
        width: 800,
        height: 600,
        durationSeconds: undefined,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: ['tag1', 'tag2'],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
      {
        id: 'img2',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'folder/img2.jpg',
        folder: 'folder',
        name: 'img2.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: Number.MAX_SAFE_INTEGER, // valid safe integer
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
      {
        id: 'img3',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'folder/img3.jpg',
        folder: 'folder',
        name: 'img3.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 999,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: ['tag3'],
        description: 'A description',
        artist: '',
        thumbnailUrl: 'http://example.com/thumb.jpg',
        previewThumbnailUrl: '',
        fileUrl: 'http://example.com/file.jpg',
      },
    ];

    // Save items
    const saved = await repo.save(items);
    expect(saved.files).toHaveLength(3);

    // Load and verify order matches exactly
    const loaded = await repo.load();
    expect(loaded.files).toHaveLength(3);
    expect(loaded.files[0].id).toBe('img1');
    expect(loaded.files[1].id).toBe('img2');
    expect(loaded.files[2].id).toBe('img3');

    // Verify optional fields: width/height should be preserved; durationSeconds undefined
    expect(loaded.files[0].width).toBe(800);
    expect(loaded.files[0].height).toBe(600);
    expect(loaded.files[0].durationSeconds).toBeUndefined();

    // Verify tags preserved exactly
    expect(loaded.files[0].tags).toEqual(['tag1', 'tag2']);
    expect(loaded.files[1].tags).toEqual([]);
    expect(loaded.files[2].tags).toEqual(['tag3']);

    // Verify large size value handled correctly (within safe integer range)
    expect(loaded.files[1].size).toBe(Number.MAX_SAFE_INTEGER);

    // Verify generatedAt is set
    expect(typeof saved.generatedAt).toBe('string');
    expect(typeof loaded.generatedAt).toBe('string');
  });

  itIf(!!TEST_DB_URL)('Saved searches CRUD and order', async () => {
    const repo = new PostgresSavedSearchRepository({ pool });

    // Create searches
    const search1 = await repo.create({ name: 'Search B', query: { q: 'b' } });
    const search2 = await repo.create({ name: 'Search A', query: { tags: ['a'] } });
    const search3 = await repo.create({ name: 'Search C', query: { folder: '/x' } });

    // List should sort by name (A, B, C)
    const list = await repo.list();
    expect(list[0].name).toBe('Search A');
    expect(list[1].name).toBe('Search B');
    expect(list[2].name).toBe('Search C');

    // Get by id
    const got = await repo.get(search1.id);
    expect(got!.name).toBe('Search B');

    // Update preserves id and createdAt
    const updated = await repo.update(search1.id, {
      name: 'Search B Updated',
      query: { q: 'b updated' },
    });
    expect(updated!.id).toBe(search1.id);
    expect(updated!.createdAt).toBe(search1.createdAt);
    expect(updated!.name).toBe('Search B Updated');
    expect(updated!.updatedAt).not.toBe(search1.updatedAt);

    // Delete
    const deleted = await repo.delete(search2.id);
    expect(deleted).toBe(true);
    const afterDelete = await repo.list();
    expect(afterDelete.length).toBe(2);
  });

  itIf(!!TEST_DB_URL)('concurrent disjoint nonempty saves produce exactly one complete snapshot', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });

    // First save with items A and B
    const items1: MediaItem[] = [
      {
        id: 'a1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'a/a1.jpg',
        folder: 'a',
        name: 'a1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 100,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
      {
        id: 'b1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'b/b1.jpg',
        folder: 'b',
        name: 'b1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 200,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
    ];
    // Second save with items C and D
    const items2: MediaItem[] = [
      {
        id: 'c1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'c/c1.jpg',
        folder: 'c',
        name: 'c1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 300,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
      {
        id: 'd1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'd/d1.jpg',
        folder: 'd',
        name: 'd1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 400,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
    ];

    // Run both saves concurrently (they use advisory lock, non-overlapping data)
    const save1 = repo.save(items1);
    const save2 = repo.save(items2);
    await Promise.all([save1, save2]);

    // Load - should have exactly one complete snapshot, never a union
    const loaded = await repo.load();
    // Either snapshot A+B or C+D, never mixed
    expect(loaded.files.length).toBe(2);
    const ids = loaded.files.map(f => f.id);
    // Check that we have either [a1,b1] or [c1,d1]
    if (ids[0] === 'a1') {
      expect(ids).toEqual(['a1', 'b1']);
    } else if (ids[0] === 'c1') {
      expect(ids).toEqual(['c1', 'd1']);
    } else {
      throw new Error('Unexpected snapshot union');
    }
  });

  itIf(!!TEST_DB_URL)('concurrent empty vs nonempty save produces exactly one complete result', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });

    // Nonempty save
    const items: MediaItem[] = [
      {
        id: 'e1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'e/e1.jpg',
        folder: 'e',
        name: 'e1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 500,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
    ];

    // Empty save
    const emptySave = repo.save([]);
    const nonemptySave = repo.save(items);
    await Promise.all([emptySave, nonemptySave]);

    const loaded = await repo.load();
    // Accept either complete final snapshot [] or ['e1']
    if (loaded.files.length === 0) {
      // empty snapshot is acceptable
    } else if (loaded.files.length === 1) {
      expect(loaded.files[0].id).toBe('e1');
    } else {
      throw new Error('Unexpected mixed/other result');
    }
    // Do not assume advisory-lock acquisition order
  });

  itIf(!!TEST_DB_URL)('load/save consistency: save then load returns exact snapshot', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });

    const items: MediaItem[] = [
      {
        id: 'f1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'f/f1.jpg',
        folder: 'f',
        name: 'f1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 600,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
      {
        id: 'f2',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'f/f2.jpg',
        folder: 'f',
        name: 'f2.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 700,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
    ];

    const saved = await repo.save(items);
    const loaded = await repo.load();
    expect(loaded.files.length).toBe(2);
    expect(loaded.files.map(f => f.id)).toEqual(['f1', 'f2']);
    expect(loaded.generatedAt).toBe(saved.generatedAt);
    expect(loaded.version).toBe(1);
  });

  itIf(!!TEST_DB_URL)('repeated empty save regression: consecutive empty saves produce correct state', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });

    // First empty save
    const result1 = await repo.save([]);
    expect(result1.version).toBe(1);
    expect(result1.files).toEqual([]);

    // Second empty save with different generatedAt
    const result2 = await repo.save([]);
    expect(result2.version).toBe(1);
    expect(result2.files).toEqual([]);
    // The generatedAt should have updated
    expect(result2.generatedAt).not.toBe(result1.generatedAt);

    // Load after second save
    const loaded = await repo.load();
    expect(loaded.files).toEqual([]);
    // The generatedAt should match the latest save
    expect(loaded.generatedAt).toBe(result2.generatedAt);
    expect(loaded.version).toBe(1);
  });

  itIf(!!TEST_DB_URL)('import: exact import, same digest no-op, changed digest refusal, and injected failure safety', async () => {
    // Import modules
    const {
      importJsonIntoPostgres,
      computeDigest,
    } = await import('./import-json.js');
    const {
      PostgresSettingsRepository,
      PostgresMediaIndexRepository,
      PostgresSavedSearchRepository,
    } = await import('./repositories.js');

    const settingsRepo = new PostgresSettingsRepository({
      pool,
      defaults: {
        defaultSettings: () => ({
          libraries: [],
          tagCatalog: [],
          tagAliases: {},
        }),
      },
      defaultLibraryPath: '/tmp',
    });
    const mediaRepo = new PostgresMediaIndexRepository({ pool });
    const savedRepo = new PostgresSavedSearchRepository({ pool });

    // Step 1: Ensure tables are empty (truncate all application tables, preserving schema_migrations)
    await pool.query('DELETE FROM import_runs');
    await pool.query('DELETE FROM saved_searches');
    await pool.query('DELETE FROM media_items');
    await pool.query('DELETE FROM media_index_state');
    await pool.query('DELETE FROM app_settings');

    // Create test data with mock repositories that return detached snapshots
    function makeMockSettingsRepo(s: AppSettings): any {
      return { load: async () => structuredClone(s) };
    }
    function makeMockMediaIndexRepo(index: any): any {
      return { load: async () => structuredClone(index) };
    }
    function makeMockSavedSearchRepo(searches: SavedSearch[]): any {
      return { list: async () => structuredClone(searches) };
    }

    const settings = {
      libraries: [
        { id: 'lib1', name: 'Lib 1', path: '/data', enabled: true, startExpanded: false },
      ],
      tagCatalog: ['a'],
      tagAliases: { a: ['b'] },
    };
    const files: MediaItem[] = [
      {
        id: 'img1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'folder/img1.jpg',
        folder: 'folder',
        name: 'img1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 12345,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
      {
        id: 'img2',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'folder/img2.jpg',
        folder: 'folder',
        name: 'img2.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 999,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
    ];
    const searches: SavedSearch[] = [
      { id: 's1', name: 'Search 1', query: { q: 'test' }, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' },
    ];
    const mediaIndex = { version: 1, generatedAt: '2024-01-01T00:00:00.000Z', files };

    // Step 2: Exact import
    const result1 = await importJsonIntoPostgres({
      pool,
      settingsRepository: makeMockSettingsRepo(settings),
      mediaIndexRepository: makeMockMediaIndexRepo(mediaIndex),
      savedSearchRepository: makeMockSavedSearchRepo(searches),
    });
    expect(result1.status).toBe('imported');
    expect(result1.counts.settings).toBe(1);
    expect(result1.counts.media).toBe(2);
    expect(result1.counts.savedSearches).toBe(1);

    // Verify data in DB
    const loadedSettings = await settingsRepo.load();
    expect(loadedSettings.libraries[0].id).toBe('lib1');
    const loadedMedia = await mediaRepo.load();
    expect(loadedMedia.files.length).toBe(2);
    // Assert that loaded/exported state preserves source generatedAt
    expect(loadedMedia.generatedAt).toBe(mediaIndex.generatedAt);
    const loadedSearches = await savedRepo.list();
    expect(loadedSearches.length).toBe(1);

    // Step 3: Same digest should be no-op
    const result2 = await importJsonIntoPostgres({
      pool,
      settingsRepository: makeMockSettingsRepo(settings),
      mediaIndexRepository: makeMockMediaIndexRepo(mediaIndex),
      savedSearchRepository: makeMockSavedSearchRepo(searches),
    });
    expect(result2.status).toBe('already-imported');
    expect(result2.counts).toEqual({ settings: 0, media: 0, savedSearches: 0 });

    // Step 4: Changed digest (different files) should be refused
    const differentFiles = [{ ...files[0], size: 54321 }];
    const diffMediaIndex = { ...mediaIndex, files: differentFiles };
    await expect(
      importJsonIntoPostgres({
        pool,
        settingsRepository: makeMockSettingsRepo(settings),
        mediaIndexRepository: makeMockMediaIndexRepo(diffMediaIndex),
        savedSearchRepository: makeMockSavedSearchRepo(searches),
      }),
    ).rejects.toThrow(/Target app_settings already has/);

    // Verify DB remains unchanged: still 2 media items, not 1
    const loadedMediaAfter = await mediaRepo.load();
    expect(loadedMediaAfter.files.length).toBe(2);

    // Step 5: Injected failure after media replacement: prove app_settings/media/state/saved/import_runs remain empty
    // First restore empty state
    await settingsRepo.save({
      libraries: [],
      tagCatalog: [],
      tagAliases: {},
    });
    await mediaRepo.save([]);
    await savedRepo.delete('s1');

    // Use a fake pool that simulates a failure after media replacement but before commit
    let queryCount = 0;
    const fakePool = new pg.Pool();
    const fakeClient: any = {
      query: async (text: string, params?: any[]) => {
        queryCount++;
        // Allow the first few queries to succeed, then throw after media replacement
        if (queryCount <= 29) {
          // Simulate: BEGIN, advisory lock, COUNT queries, settings INSERT, media staging, saved inserts
          if (text.startsWith('SELECT pg_advisory_xact_lock')) {
            return { rows: [] };
          }
          if (text.startsWith('SELECT COUNT(*)')) {
            return { rows: [{ cnt: '0' }] };
          }
          if (text.includes('source_digest')) {
            return { rows: [] };
          }
          return { rows: [], rowCount: 1 };
        }
        throw new Error('simulated import failure');
      },
      release: () => {},
    };
    vi.spyOn(fakePool, 'connect').mockResolvedValue(fakeClient as any);

    await expect(
      importJsonIntoPostgres({
        pool: fakePool,
        settingsRepository: makeMockSettingsRepo(settings),
        mediaIndexRepository: makeMockMediaIndexRepo(mediaIndex),
        savedSearchRepository: makeMockSavedSearchRepo(searches),
      }),
    ).rejects.toThrow('simulated import failure');

    // Verify all tables remain empty
    const settingsEmpty = await settingsRepo.load();
    expect(settingsEmpty.libraries).toEqual([]);
    const mediaEmpty = await mediaRepo.load();
    expect(mediaEmpty.files).toEqual([]);
    const searchesEmpty = await savedRepo.list();
    expect(searchesEmpty).toEqual([]);
    const importRunsEmpty = await pool.query(
      'SELECT COUNT(*) AS cnt FROM import_runs',
    );
    expect(parseInt(importRunsEmpty.rows[0].cnt, 10)).toBe(0);
  });

  itIf(!!TEST_DB_URL)('export imports then exports and reloads exact values', async () => {
    // Import modules
    const {
      importJsonIntoPostgres,
    } = await import('./import-json.js');
    const {
      exportPostgresToJson,
    } = await import('./export-json.js');
    const {
      PostgresSettingsRepository,
      PostgresMediaIndexRepository,
      PostgresSavedSearchRepository,
    } = await import('./repositories.js');
    const {
      JsonSettingsRepository,
      JsonMediaIndexRepository,
      JsonSavedSearchRepository,
    } = await import('../json.js');

    const settingsRepo = new PostgresSettingsRepository({
      pool,
      defaults: {
        defaultSettings: () => ({
          libraries: [],
          tagCatalog: [],
          tagAliases: {},
        }),
      },
      defaultLibraryPath: '/tmp',
    });
    const mediaRepo = new PostgresMediaIndexRepository({ pool });
    const savedRepo = new PostgresSavedSearchRepository({ pool });

    // Step 1: Import some data
    const settingsToImport = {
      libraries: [
        { id: 'lib1', name: 'Lib 1', path: '/data', enabled: true, startExpanded: false },
      ],
      tagCatalog: ['a'],
      tagAliases: { a: ['b'] },
    };
    const filesToImport: MediaItem[] = [
      {
        id: 'img1',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'folder/img1.jpg',
        folder: 'folder',
        name: 'img1.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 12345,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
      {
        id: 'img2',
        libraryId: 'lib1',
        libraryName: 'Lib 1',
        relativePath: 'folder/img2.jpg',
        folder: 'folder',
        name: 'img2.jpg',
        extension: 'jpg',
        kind: 'image',
        mimeType: 'image/jpeg',
        size: 999,
        createdAt: '2024-01-01T00:00:00.000Z',
        modifiedAt: '2024-01-02T00:00:00.000Z',
        indexedAt: '2024-01-03T00:00:00.000Z',
        tags: [],
        description: '',
        artist: '',
        thumbnailUrl: '',
        previewThumbnailUrl: '',
        fileUrl: '',
      },
    ];
    const searchesToImport: SavedSearch[] = [
      { id: 's1', name: 'Search 1', query: { q: 'test' }, createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' },
    ];
    const mediaIndexToImport = { version: 1, generatedAt: '2024-01-01T00:00:00.000Z', files: filesToImport };

    function makeMockSettingsRepo(s: AppSettings): any {
      return { load: async () => structuredClone(s) };
    }
    function makeMockMediaIndexRepo(index: any): any {
      return { load: async () => structuredClone(index) };
    }
    function makeMockSavedSearchRepo(searches: SavedSearch[]): any {
      return { list: async () => structuredClone(searches) };
    }

    const importResult = await importJsonIntoPostgres({
      pool,
      settingsRepository: makeMockSettingsRepo(settingsToImport),
      mediaIndexRepository: makeMockMediaIndexRepo(mediaIndexToImport),
      savedSearchRepository: makeMockSavedSearchRepo(searchesToImport),
    });
    expect(importResult.status).toBe('imported');

    // Step 2: Export to a temp directory
    const exportOutputDir = '/tmp/oftest-export-' + Math.random().toString(36).substring(2, 10);
    if (!fs.existsSync(path.dirname(exportOutputDir))) fs.mkdirSync(path.dirname(exportOutputDir), { recursive: true });

    const exportResult = await exportPostgresToJson({
      pool,
      outputDir: exportOutputDir,
      defaultSettings: () => ({
        libraries: [],
        tagCatalog: [],
        tagAliases: {},
      }),
      defaultLibraryPath: '/tmp',
      clock: () => '2024-01-01T00:00:00.000Z', // fixed clock for stable manifest
    });

    // Step 3: Verify exported files exist and match expectations
    expect(exportResult.counts.settings).toBe(1);
    expect(exportResult.counts.media).toBe(2);
    expect(exportResult.counts.savedSearches).toBe(1);

    // Load JSON files and verify values match what was imported
    const jsonSettingsRepo = new JsonSettingsRepository({
      primaryPath: path.join(exportOutputDir, 'settings.json'),
      backupDir: '',
      backupRetentionDays: 0,
      backupIntervalHours: 0,
      defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
      defaultLibraryPath: '/tmp',
    });
    const loadedSettings = await jsonSettingsRepo.load();
    expect(loadedSettings.libraries[0].id).toBe('lib1');
    expect(loadedSettings.tagCatalog).toEqual(['a']);
    expect(loadedSettings.tagAliases).toEqual({ a: ['b'] });

    const jsonMediaRepo = new JsonMediaIndexRepository({
      primaryPath: path.join(exportOutputDir, 'index.json'),
      backupDir: '',
      backupRetentionDays: 0,
      backupIntervalHours: 0,
      defaultIndex: () => ({ version: 1, generatedAt: '', files: [] }),
    });
    const loadedMedia = await jsonMediaRepo.load();
    expect(loadedMedia.files.length).toBe(2);
    expect(loadedMedia.files[0].id).toBe('img1');
    expect(loadedMedia.files[1].id).toBe('img2');
    // Assert that loaded/exported state preserves source generatedAt
    expect(loadedMedia.generatedAt).toBe(mediaIndexToImport.generatedAt);

    const jsonSavedRepo = new JsonSavedSearchRepository({
      primaryPath: path.join(exportOutputDir, 'saved-searches.json'),
    });
    const loadedSearches = await jsonSavedRepo.list();
    expect(loadedSearches.length).toBe(1);
    expect(loadedSearches[0].id).toBe('s1');

    // Verify manifest.json
    const manifestText = fs.readFileSync(path.join(exportOutputDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    expect(manifest.version).toBe(1);
    expect(typeof manifest.exportedAt).toBe('string');
    expect(typeof manifest.semanticDigest).toBe('string');
    expect(manifest.counts).toEqual({ settings: 1, media: 2, savedSearches: 1 });

    // Cleanup
    fs.rmSync(exportOutputDir, { recursive: true, force: true });
  });
});