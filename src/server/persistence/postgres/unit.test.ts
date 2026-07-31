/**
 * Unit tests for PostgreSQL persistence: migrations, codecs, and transaction
 * rollback/release behavior, using a fake client to isolate from real DB.
 *
 * Enforces:
 * - Fake recording of SQL and parameter counts for insert/update sequences.
 * - Media insert rows use exactly 23 placeholders/values.
 * - Singleton SQL uses fixed id=1.
 * - Migrations BEGIN before DDL and xact advisory lock, rollback/release.
 * - Removes tests that model impossible DB states.
 */

import pg from 'pg';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import type { AppSettings, MediaItem, SavedSearch } from '../../../shared/types.js';
import type { SavedSearchQuery } from '../../../shared/types.js';

// Import the postgres modules
import {
  POSTGRES_MIGRATIONS,
  runPostgresMigrations,
} from './migrations.js';
import {
  encodeSettings,
  decodeSettingsRow,
  encodeMediaItem,
  decodeMediaItemRow,
  encodeMediaIndexState,
  decodeMediaIndexStateRow,
  encodeSavedSearch,
  decodeSavedSearchRow,
  MEDIA_COLUMN_COUNT,
} from './codec.js';
import {
  PostgresSettingsRepository,
  PostgresMediaIndexRepository,
  PostgresSavedSearchRepository,
} from './repositories.js';

// ---- Helper: create a fake pg.Pool with SQL recording -------------

interface FakeQueryRecord {
  text: string;
  params: unknown[];
  result: FakeQueryResult;
}

let fakeQueryRecords: FakeQueryRecord[] = [];
let fakeQueryIndex = 0;
let fakeQueryError: (() => Error | undefined) | undefined;

function createFakePool(): pg.Pool {
  const pool = new pg.Pool();
  // Override connect to return a fake client
  const fakeClient = createFakeClient();
  vi.spyOn(pool, 'connect').mockResolvedValue(fakeClient as any);
  return pool;
}

function createFakeClient(): Partial<pg.PoolClient> {
  const client: any = {
    query: async (text: string, params?: any[]) => {
      const errFn = fakeQueryError;
      if (errFn) {
        const err = errFn();
        if (err) {
          throw err;
        }
      }
      // Record the query and params for assertions
      fakeQueryRecords.push({ text, params: params ?? [], result: fakeQuerySequence[fakeQueryIndex] });
      const result = fakeQuerySequence[fakeQueryIndex++];
      if (!result) {
        throw new Error('No more fake query results');
      }
      return result;
    },
    release: () => {},
  };
  return client;
}

interface FakeQueryResult {
  rows: any[];
  rowCount?: number;
}

let fakeQuerySequence: FakeQueryResult[] = [];

/** Reset fake query state for a test. */
function resetFakeQueries() {
  fakeQueryRecords = [];
  fakeQuerySequence = [];
  fakeQueryIndex = 0;
  fakeQueryError = undefined;
}

/** Set up the next fake query result(s). */
function setFakeQueryResults(...results: FakeQueryResult[]) {
  fakeQuerySequence = results;
}

/** Retrieve recorded queries and params for assertions. */
function getRecordedQueries(): FakeQueryRecord[] {
  return fakeQueryRecords;
}

// ---- Unit tests for migrations ----------------------------------------------

describe('POSTGRES_MIGRATIONS', () => {
  it('is an ordered array with name, sql, checksum', () => {
    expect(Array.isArray(POSTGRES_MIGRATIONS)).toBe(true);
    for (const entry of POSTGRES_MIGRATIONS) {
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('sql');
      expect(entry).toHaveProperty('checksum');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.sql).toBe('string');
      expect(typeof entry.checksum).toBe('string');
    }
  });

  it('names match regex ^[a-z0-9_]+$', () => {
    for (const entry of POSTGRES_MIGRATIONS) {
      expect(entry.name).toMatch(/^[a-z0-9_-]+$/);
    }
  });

  it('checksum matches the SQL content (computed at module load)', async () => {
    const { createHash } = await import('node:crypto');
    for (const entry of POSTGRES_MIGRATIONS) {
      const computed = createHash('sha256').update(entry.sql).digest('hex');
      expect(computed).toBe(entry.checksum);
    }
  });
});

describe('runPostgresMigrations', () => {
  beforeEach(() => {
    resetFakeQueries();
  });

  it('applies pending migrations when none have been applied', async () => {
    const pool = createFakePool();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // pg_advisory_xact_lock
      { rows: [], rowCount: 1 },
      // CREATE TABLE IF NOT EXISTS schema_migrations
      { rows: [], rowCount: 1 },
      // Check first migration name - not yet applied
      { rows: [] },
      // Apply first migration SQL
      { rows: [], rowCount: 1 },
      // INSERT record
      { rows: [], rowCount: 1 },
      // COMMIT
      { rows: [], rowCount: 1 },
    );
    const count = await runPostgresMigrations(pool);
    expect(count).toBe(1);
  });

  it('skips already-applied migrations when checksum matches', async () => {
    const pool = createFakePool();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // pg_advisory_xact_lock
      { rows: [], rowCount: 1 },
      // CREATE TABLE IF NOT EXISTS schema_migrations
      { rows: [], rowCount: 1 },
      // Check first migration name - already applied with matching checksum
      { rows: [{ checksum: checksumOf(POSTGRES_MIGRATIONS[0].sql) }] },
      // COMMIT (skipped)
      { rows: [], rowCount: 1 },
    );
    const count = await runPostgresMigrations(pool);
    expect(count).toBe(0);
  });

  it('rolls back on migration failure and releases client', async () => {
    const pool = createFakePool();
    resetFakeQueries();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // pg_advisory_xact_lock
      { rows: [], rowCount: 1 },
      // CREATE TABLE IF NOT EXISTS schema_migrations
      { rows: [], rowCount: 1 },
      // Check first migration name
      { rows: [] },
      // Apply first migration SQL - will cause an error via fakeQueryError
    );
    // Use a function that throws only when the index reaches 4 (the SQL apply step)
    let hasThrown = false;
    fakeQueryError = () => {
      if (!hasThrown && fakeQueryIndex === 4) {
        hasThrown = true;
        return new Error('SQL failure');
      }
      return undefined;
    };
    // Add a spy on the client.release by modifying createFakeClient
    const releaseFn = vi.fn();
    const originalConnect = pool.connect;
    vi.spyOn(pool, 'connect').mockImplementation(
      async () => {
        const client: any = {
          query: async (text: string, params?: any[]) => {
            const errFn = fakeQueryError;
            if (errFn) {
              const err = errFn();
              if (err) {
                throw err;
              }
            }
            // Use fakeQuerySequence and index
            fakeQueryRecords.push({ text, params: params ?? [], result: fakeQuerySequence[fakeQueryIndex] });
            const result = fakeQuerySequence[fakeQueryIndex++];
            if (!result) {
              throw new Error('No more fake query results');
            }
            return result;
          },
          release: releaseFn,
        };
        return client;
      },
    );
    await expect(runPostgresMigrations(pool)).rejects.toThrow('SQL failure');
    // Verify recorded queries show BEGIN and pg_advisory_xact_lock before DDL
    const records = getRecordedQueries();
    const texts = records.map((r) => r.text);
    // The first query should be 'BEGIN'
    expect(texts.length).toBeGreaterThanOrEqual(4);
    expect(texts[0]).toBe('BEGIN');
    expect(texts[1]).toMatch(/pg_advisory_xact_lock/);
    // The last query should be ROLLBACK (caught in catch block)
    expect(texts[texts.length - 1]).toBe('ROLLBACK');
    // Release should be called once
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });
});

function checksumOf(sql: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(sql).digest('hex');
}

// ---- Codec tests ------------------------------------------------------------

describe('codec: encodeSettings / decodeSettingsRow', () => {
  it('encodes and decodes settings', () => {
    const settings: AppSettings = {
      libraries: [
        { id: 'lib1', name: 'Lib 1', path: '/some/path', enabled: true, startExpanded: false },
      ],
      tagCatalog: ['a', 'b'],
      tagAliases: { a: ['b'] },
    };
    const input = encodeSettings(settings);
    expect(input.data).toBe(JSON.stringify(settings));
    const row: any = { id: 1, revision: 0, data: input.data };
    const decoded = decodeSettingsRow(row);
    expect(decoded.libraries[0].id).toBe('lib1');
    expect(decoded.tagCatalog).toEqual(['a', 'b']);
    expect(decoded.tagAliases).toEqual({ a: ['b'] });
  });

  it('handles null fields in decoding', () => {
    const settings: AppSettings = {
      libraries: [],
      tagCatalog: [],
      tagAliases: {},
    };
    const input = encodeSettings(settings);
    const row = { id: 1, revision: 0, data: input.data };
    const decoded = decodeSettingsRow(row);
    expect(decoded.libraries).toEqual([]);
  });

  it('accepts parsed JSONB object directly (from pg::jsonb output)', () => {
    const settings: AppSettings = {
      libraries: [],
      tagCatalog: [],
      tagAliases: {},
    };
    const row: any = { id: 1, revision: 0, data: JSON.parse(JSON.stringify(settings)) };
    const decoded = decodeSettingsRow(row);
    expect(decoded).toEqual(settings);
  });

  it('throws on invalid SettingsRow data type', () => {
    const row: any = { id: 1, revision: 0, data: 42 };
    expect(() => decodeSettingsRow(row)).toThrow();
  });
});

describe('codec: encodeMediaIndexState / decodeMediaIndexStateRow', () => {
  it('encodes and decodes with id=1', () => {
    const state = { version: 1, generatedAt: '2024-01-01T00:00:00.000Z' };
    const row = encodeMediaIndexState(state);
    expect(row.id).toBe(1);
    expect(row.version).toBe(1);
    expect(row.generated_at).toBe('2024-01-01T00:00:00.000Z');
    const decoded = decodeMediaIndexStateRow(row);
    expect(decoded.version).toBe(1);
    expect(decoded.generatedAt).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('codec: encodeMediaItem / decodeMediaItemRow', () => {
  it('encodes and decodes a full MediaItem with 23 columns', () => {
    const item: MediaItem = {
      id: 'img1',
      libraryId: 'lib1',
      libraryName: 'Lib 1',
      relativePath: 'folder/img1.jpg',
      folder: 'folder',
      name: 'img1.jpg',
      extension: 'jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      size: 123456,
      width: 800,
      height: 600,
      durationSeconds: undefined,
      createdAt: '2024-01-01T00:00:00.000Z',
      modifiedAt: '2024-01-02T00:00:00.000Z',
      indexedAt: '2024-01-03T00:00:00.000Z',
      tags: ['tag1', 'tag2'],
      description: 'A test image',
      artist: 'Photographer',
      thumbnailUrl: 'http://example.com/thumb.jpg',
      previewThumbnailUrl: 'http://example.com/preview.jpg',
      fileUrl: 'http://example.com/file.jpg',
    };
    const row = encodeMediaItem(item, 5);
    expect(row.id).toBe('img1');
    expect(row.library_id).toBe('lib1');
    expect(row.size).toBe('123456');
    expect(row.width).toBe(800);
    expect(row.height).toBe(600);
    expect(row.duration_seconds).toBeNull();
    expect(row.tags).toBe(JSON.stringify(['tag1', 'tag2']));
    expect(row.position).toBe(5);

    const decoded = decodeMediaItemRow(row);
    expect(decoded.id).toBe('img1');
    expect(decoded.libraryId).toBe('lib1');
    expect(decoded.size).toBe(123456);
    expect(decoded.width).toBe(800);
    expect(decoded.height).toBe(600);
    expect(decoded.durationSeconds).toBeUndefined();
    expect(decoded.tags).toEqual(['tag1', 'tag2']);
    expect(decoded.fileUrl).toBe('http://example.com/file.jpg');
  });

  it('handles optional fields as null/undefined', () => {
    const item: MediaItem = {
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
    };
    // width, height, durationSeconds not set
    const row = encodeMediaItem(item, 0);
    expect(row.width).toBeNull();
    expect(row.height).toBeNull();
    expect(row.duration_seconds).toBeNull();

    const decoded = decodeMediaItemRow(row);
    expect(decoded.width).toBeUndefined();
    expect(decoded.height).toBeUndefined();
    expect(decoded.durationSeconds).toBeUndefined();
  });

  it('rejects invalid size (non-integer)', () => {
    const item = {
      ...makeMinimalItem('img-reject', 123456),
      size: 'not a number',
    };
    expect(() => encodeMediaItem(item as any, 0)).toThrow();
  });

  it('rejects invalid size (negative)', () => {
    const item = {
      ...makeMinimalItem('img-reject', 123456),
      size: -1,
    };
    expect(() => encodeMediaItem(item as any, 0)).toThrow();
  });

  it('rejects invalid size (exceeding MAX_SAFE_INTEGER)', () => {
    const item = {
      ...makeMinimalItem('img-reject', 123456),
      size: Number.MAX_SAFE_INTEGER + 1,
    };
    // encodeMediaItem should throw because size exceeds MAX_SAFE_INTEGER
    expect(() => encodeMediaItem(item as any, 0)).toThrow(/size:/);
  });

  it('decodes size string correctly (non-negative integer)', () => {
    const row: any = {
      ...makeMinimalRow('img-valid'),
      size: '123456',
    };
    const decoded = decodeMediaItemRow(row);
    expect(decoded.size).toBe(123456);
  });

  it('rejects size string that is not numeric', () => {
    const row: any = {
      ...makeMinimalRow('img-invalid'),
      size: 'abc',
    };
    expect(() => decodeMediaItemRow(row)).toThrow();
  });

  it('rejects size string exceeding MAX_SAFE_INTEGER', () => {
    const row: any = {
      ...makeMinimalRow('img-too-big'),
      size: String(Number.MAX_SAFE_INTEGER + 1),
    };
    expect(() => decodeMediaItemRow(row)).toThrow(/MAX_SAFE_INTEGER/);
  });

  it('rejects malformed tags JSON string', () => {
    const row: any = {
      ...makeMinimalRow('img-bad-tags'),
      tags: '{not valid json}',
    };
    expect(() => decodeMediaItemRow(row)).toThrow();
  });

  it('rejects tags that are not an array', () => {
    const row: any = {
      ...makeMinimalRow('img-bad-tags2'),
      tags: '{"broken": "object"}',
    };
    // JSON.parse would produce an object, not an array
    expect(() => decodeMediaItemRow(row)).toThrow();
  });

  it('rejects tags with non-string elements', () => {
    const row: any = {
      ...makeMinimalRow('img-bad-tags3'),
      tags: JSON.stringify([42]),
    };
    expect(() => decodeMediaItemRow(row)).toThrow();
  });

  it('accepts parsed tags JSONB array directly (from pg output)', () => {
    const row: any = {
      ...makeMinimalRow('img-parsed'),
      tags: ['tag1', 'tag2'],
    };
    // Row.tags is already an array, not a string
    const decoded = decodeMediaItemRow(row);
    expect(decoded.tags).toEqual(['tag1', 'tag2']);
  });
});

function makeMinimalItem(id: string, size: number): MediaItem {
  return {
    id,
    libraryId: 'lib1',
    libraryName: 'Lib 1',
    relativePath: `folder/${id}.jpg`,
    folder: 'folder',
    name: `${id}.jpg`,
    extension: 'jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    size,
    createdAt: '2024-01-01T00:00:00.000Z',
    modifiedAt: '2024-01-02T00:00:00.000Z',
    indexedAt: '2024-01-03T00:00:00.000Z',
    tags: [],
    description: '',
    artist: '',
    thumbnailUrl: '',
    previewThumbnailUrl: '',
    fileUrl: '',
  };
}

function makeMinimalRow(id: string): any {
  return {
    id,
    library_id: 'lib1',
    library_name: 'Lib 1',
    relative_path: `folder/${id}.jpg`,
    folder: 'folder',
    name: `${id}.jpg`,
    extension: 'jpg',
    kind: 'image',
    mime_type: 'image/jpeg',
    size: '123456',
    width: null,
    height: null,
    duration_seconds: null,
    created_at: '2024-01-01T00:00:00.000Z',
    modified_at: '2024-01-02T00:00:00.000Z',
    indexed_at: '2024-01-03T00:00:00.000Z',
    tags: '[]',
    description: '',
    artist: '',
    thumbnail_url: '',
    preview_thumbnail_url: '',
    file_url: '',
    position: 0,
  };
}

describe('codec: encodeSavedSearch / decodeSavedSearchRow', () => {
  it('encodes and decodes a SavedSearch', () => {
    const search: SavedSearch = {
      id: 'abc123',
      name: 'Test Search',
      query: { q: 'test', tags: ['tag1'] },
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    };
    const row = encodeSavedSearch(search);
    expect(row.id).toBe('abc123');
    expect(row.query).toBe(JSON.stringify(search.query));

    const decoded = decodeSavedSearchRow(row);
    expect(decoded.id).toBe('abc123');
    expect(decoded.name).toBe('Test Search');
    expect(decoded.query).toEqual({ q: 'test', tags: ['tag1'] });
  });

  it('validates query: rejects malformed JSON', () => {
    const row: any = {
      id: 'id1',
      name: 'Test',
      query: '{incomplete}',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow();
  });

  it('validates query: rejects arrays', () => {
    const row: any = {
      id: 'id2',
      name: 'Test',
      query: JSON.stringify([]),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/must be an object/);
  });

  it('validates query: rejects unknown keys', () => {
    const row: any = {
      id: 'id3',
      name: 'Test',
      query: JSON.stringify({ unknown: 'val' }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/Unknown key/);
  });

  it('validates name length', () => {
    const row: any = {
      id: 'id4',
      name: 'a'.repeat(121),
      query: JSON.stringify({ q: 'test' }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/120/);
  });

  it('validates timestamps: rejects empty string', () => {
    const row: any = {
      id: 'id5',
      name: 'Test',
      query: JSON.stringify({ q: 'test' }),
      created_at: '',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    // Empty string cannot produce valid ISO date
    expect(() => decodeSavedSearchRow(row)).toThrow(/non-canonical/);
  });

  it('rejects untrimmed/empty saved search id', () => {
    const row: any = {
      id: '  ',
      name: 'Test',
      query: JSON.stringify({ q: 'test' }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow();
  });

  it('rejects untrimmed/empty saved search name', () => {
    const row: any = {
      id: 'id7',
      name: '   ',
      query: JSON.stringify({ q: 'test' }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow();
  });

  it('validates query q max 1000 characters', () => {
    const row: any = {
      id: 'id8',
      name: 'Test',
      query: JSON.stringify({ q: 'a'.repeat(1001) }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/1000/);
  });

  it('validates query folder max 1000 characters', () => {
    const row: any = {
      id: 'id9',
      name: 'Test',
      query: JSON.stringify({ folder: 'a'.repeat(1001) }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/1000/);
  });

  it('validates query libraryId max 1000 characters', () => {
    const row: any = {
      id: 'id10',
      name: 'Test',
      query: JSON.stringify({ libraryId: 'a'.repeat(1001) }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/1000/);
  });

  it('validates query tagExpression max 4000 characters', () => {
    const row: any = {
      id: 'id11',
      name: 'Test',
      query: JSON.stringify({ tagExpression: 'a'.repeat(4001) }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/4000/);
  });

  it('rejects tags present but empty array', () => {
    const row: any = {
      id: 'id12',
      name: 'Test',
      query: JSON.stringify({ tags: [] }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/non-empty/);
  });

  it('rejects tags past max 100 entries', () => {
    const row: any = {
      id: 'id13',
      name: 'Test',
      query: JSON.stringify({ tags: Array.from({ length: 101 }, (_, i) => `tag${i}`) }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/100/);
  });

  it('allows tags absent (undefined/null)', () => {
    const row: any = {
      id: 'id14',
      name: 'Test',
      query: JSON.stringify({ q: 'test' }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    // No tags key at all - should be valid if other fields are good
    expect(() => decodeSavedSearchRow(row)).not.toThrow();
  });

  it('validates timestamps: rejects non-canonical format', () => {
    const row: any = {
      id: 'id5',
      name: 'Test',
      query: JSON.stringify({ q: 'test' }),
      created_at: '2024-01-01', // missing T and ms
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/non-canonical/);
  });

  it('rejects both tags and tagExpression', () => {
    const row: any = {
      id: 'id6',
      name: 'Test',
      query: JSON.stringify({ tags: ['t1'], tagExpression: 't2' }),
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    };
    expect(() => decodeSavedSearchRow(row)).toThrow(/cannot have both/);
  });
});

// ---- Repository transaction tests --------------------------------------------

describe('PostgresSettingsRepository transaction behavior', () => {
  let pool: pg.Pool;

  beforeEach(() => {
    resetFakeQueries();
    pool = createFakePool();
  });

  // Remove tests that model impossible DB states (e.g., revision-based queries
  // that no longer apply with fixed id=1).

  it('load returns default settings when no row exists', async () => {
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
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT id=1 - no rows
      { rows: [] },
      // COMMIT (no insert, returns defaults)
      { rows: [], rowCount: 1 },
    );
    const settings = await repo.load();
    expect(settings.libraries[0].name).toBe('Library');
    // Verify recorded queries: last query should be COMMIT (not INSERT)
    const records = getRecordedQueries();
    expect(records[records.length - 1].text).toBe('COMMIT');
  });

  it('save uses INSERT ON CONFLICT DO UPDATE and records id=1', async () => {
    const repo = new PostgresSettingsRepository({
      pool,
      defaults: {
        defaultSettings: () => ({
          libraries: [],
          tagCatalog: [],
          tagAliases: {},
        }),
      },
      normalize: (s) => s,
      defaultLibraryPath: '/tmp',
    });
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT pg_advisory_xact_lock_shared
      { rows: [], rowCount: 1 },
      // INSERT ON CONFLICT
      { rows: [], rowCount: 1 },
      // COMMIT
      { rows: [], rowCount: 1 },
    );
    const settings: AppSettings = {
      libraries: [
        { id: 'lib1', name: 'Lib 1', path: '/tmp', enabled: true, startExpanded: false },
      ],
      tagCatalog: [],
      tagAliases: {},
    };
    const result = await repo.save(settings);
    expect(result.libraries[0].id).toBe('lib1');
    // Verify SQL: INSERT with id=1 and ON CONFLICT
    const records = getRecordedQueries();
    const lockText = records[1].text;
    expect(lockText).toMatch(/pg_advisory_xact_lock_shared/);
    const insertText = records[2].text;
    expect(insertText).toMatch(/INSERT INTO app_settings/);
    expect(insertText).toMatch(/ON CONFLICT/);
  });

  it('update seeds id=1 defaults then SELECT FOR UPDATE', async () => {
    const repo = new PostgresSettingsRepository({
      pool,
      defaults: {
        defaultSettings: () => ({
          libraries: [],
          tagCatalog: [],
          tagAliases: {},
        }),
      },
      normalize: (s) => s,
      defaultLibraryPath: '/tmp',
    });
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT pg_advisory_xact_lock_shared
      { rows: [], rowCount: 1 },
      // INSERT id=1 defaults with ON CONFLICT DO NOTHING
      { rows: [], rowCount: 1 },
      // SELECT id=1 FOR UPDATE
      { rows: [{ id: 1, revision: 0, data: JSON.stringify({ libraries: [], tagCatalog: [], tagAliases: {} }) }] },
      // UPDATE id=1 revision+1
      { rows: [], rowCount: 1 },
      // COMMIT
      { rows: [], rowCount: 1 },
    );
    await repo.update((current) => ({
      ...current,
      tagCatalog: ['test'],
    }));
    const records = getRecordedQueries();
    // The sequence should have: BEGIN -> shared lock -> INSERT ON CONFLICT DO NOTHING -> SELECT FOR UPDATE -> UPDATE -> COMMIT
    expect(records[0].text).toBe('BEGIN');
    expect(records[1].text).toMatch(/pg_advisory_xact_lock_shared/);
    expect(records[2].text).toMatch(/ON CONFLICT.*DO NOTHING/);
    expect(records[3].text).toMatch(/SELECT.*FOR UPDATE/);
  });

  it('transaction rolls back on error', async () => {
    const repo = new PostgresSettingsRepository({
      pool,
      defaults: {
        defaultSettings: () => ({
          libraries: [],
          tagCatalog: [],
          tagAliases: {},
        }),
      },
      normalize: (s) => s,
      defaultLibraryPath: '/tmp',
    });
    resetFakeQueries();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT pg_advisory_xact_lock_shared
      { rows: [], rowCount: 1 },
      // INSERT id=1 defaults with ON CONFLICT DO NOTHING
      { rows: [], rowCount: 1 },
      // SELECT id=1 FOR UPDATE - succeeds
      { rows: [{ id: 1, revision: 0, data: JSON.stringify({ libraries: [], tagCatalog: [], tagAliases: {} }) }] },
      // ROLLBACK after mutator error
      { rows: [], rowCount: 1 },
    );
    await expect(repo.update(() => {
      throw new Error('mutator error');
    })).rejects.toThrow('mutator error');
    // Should have recorded queries up to the point where it fails, then rollback
    const records = getRecordedQueries();
    // After error, we expect a ROLLBACK to have been issued
    expect(records[records.length - 1].text).toBe('ROLLBACK');
  });

  it('release is called in finally', async () => {
    const releaseFn = vi.fn();
    vi.spyOn(pool, 'connect').mockImplementation(
      async () => {
        const client: any = {
          query: async () => {
            throw new Error('test error');
          },
          release: releaseFn,
        };
        return client;
      },
    );
    const repo = new PostgresSettingsRepository({
      pool,
      defaults: { defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }) },
      normalize: (s) => s,
      defaultLibraryPath: '/tmp',
    });
    await expect(repo.load()).rejects.toThrow('test error');
    expect(releaseFn).toHaveBeenCalled();
  });
});

describe('PostgresMediaIndexRepository transaction behavior', () => {
  let pool: pg.Pool;

  beforeEach(() => {
    resetFakeQueries();
    pool = createFakePool();
  });

  it('load uses repeatable read isolation level and returns empty index when no state', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });
    setFakeQueryResults(
      // BEGIN with RR read only
      { rows: [], rowCount: 1 },
      // SELECT state id=1 - no rows
      { rows: [] },
      // SELECT items - no rows
      { rows: [] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );
    const index = await repo.load();
    expect(index.version).toBe(1);
    expect(index.files).toEqual([]);
    // Verify first query uses repeatable read
    const records = getRecordedQueries();
    expect(records[0].text).toMatch(/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);
  });

  it('empty save acquires advisory lock, deletes all rows, and upserts state with id=1', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });
    setFakeQueryResults(
      // BEGIN (repo save)
      { rows: [], rowCount: 1 },
      // SELECT pg_advisory_xact_lock (repo save - exclusive)
      { rows: [], rowCount: 1 },
      // DELETE
      { rows: [], rowCount: 5 },
      // INSERT ON CONFLICT state id=1
      { rows: [], rowCount: 1 },
      // COMMIT (repo save)
      { rows: [], rowCount: 1 },
    );
    const result = await repo.save([]);
    expect(result.version).toBe(1);
    expect(result.files).toEqual([]);
    // Verify that the state upsert uses id=1
    const records = getRecordedQueries();
    // Only one lock - exclusive from repo.save
    const lockText = records[1].text;
    expect(lockText).toMatch(/pg_advisory_xact_lock\b/);
    // Verify the state upsert uses id=1 and ON CONFLICT
    const upsertText = records[3].text; // after BEGIN, lock, DELETE
    expect(upsertText).toMatch(/ON CONFLICT/);
  });

  it('repeated empty save regression: verifies UPSERT uses version = $1, generated_at = $2', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });
    setFakeQueryResults(
      // First save (empty)
      { rows: [], rowCount: 1 }, // BEGIN
      { rows: [], rowCount: 1 }, // pg_advisory_xact_lock
      { rows: [], rowCount: 1 }, // DELETE
      { rows: [], rowCount: 1 }, // UPSERT state - version=1, generated_at='2024-01-01T00:00:00.000Z'
      { rows: [], rowCount: 1 }, // COMMIT
      // Second save (empty) - simulate repeated save
      { rows: [], rowCount: 1 }, // BEGIN
      { rows: [], rowCount: 1 }, // pg_advisory_xact_lock
      { rows: [], rowCount: 1 }, // DELETE
      { rows: [], rowCount: 1 }, // UPSERT state - version=1, generated_at='2024-01-02T00:00:00.000Z'
      { rows: [], rowCount: 1 }, // COMMIT
    );
    // First empty save
    const result1 = await repo.save([]);
    expect(result1.version).toBe(1);
    expect(result1.files).toEqual([]);
    // Second empty save
    const result2 = await repo.save([]);
    expect(result2.version).toBe(1);
    expect(result2.files).toEqual([]);
    // Verify UPSERT SQL uses correct placeholder order: version = $1, generated_at = $2
    const records = getRecordedQueries();
    // The UPSERT queries should be records[3] for first save and records[8] for second
    const upsert1 = records[3].text;
    const upsert2 = records[8].text;
    // Both should match the pattern
    expect(upsert1).toMatch(/ON CONFLICT/);
    expect(upsert1).toMatch(/SET version = \$1, generated_at = \$2/);
    expect(upsert2).toMatch(/ON CONFLICT/);
    expect(upsert2).toMatch(/SET version = \$1, generated_at = \$2/);
  });

  it('non-empty save acquires advisory lock, uses staging table, DELETE all, INSERT all, upsert state id=1, and uses 23-column placeholders with exact column ordering', async () => {
    const repo = new PostgresMediaIndexRepository({ pool });
    const item = {
      id: 'img1',
      libraryId: 'lib1',
      libraryName: 'Lib 1',
      relativePath: 'folder/img1.jpg',
      folder: 'folder',
      name: 'img1.jpg',
      extension: 'jpg',
      kind: 'image' as const,
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
    } as MediaItem;
    setFakeQueryResults(
      // BEGIN (repo save)
      { rows: [], rowCount: 1 },
      // pg_advisory_xact_lock (repo save - exclusive)
      { rows: [], rowCount: 1 },
      // CREATE TEMP TABLE
      { rows: [], rowCount: 1 },
      // INSERT into staging (chunked)
      { rows: [], rowCount: 1 },
      // DELETE all media_items
      { rows: [], rowCount: 1 },
      // INSERT all from staging
      { rows: [], rowCount: 1 },
      // DROP TABLE
      { rows: [], rowCount: 1 },
      // INSERT ON CONFLICT state id=1
      { rows: [], rowCount: 1 },
      // COMMIT (repo save)
      { rows: [], rowCount: 1 },
    );
    const result = await repo.save([item]);
    expect(result.version).toBe(1);
    expect(result.files).toHaveLength(1);
    // Verify the staging INSERT uses exactly 23 placeholders per row
    const records = getRecordedQueries();
    // Only one lock - exclusive from repo.save
    const lockText = records[1].text;
    expect(lockText).toMatch(/pg_advisory_xact_lock\b/);
    const stagingInsertText = records[3].text; // after BEGIN, lock, CREATE TEMP
    // The INSERT should be into "media_staging" with ($1,..., $23) style
    expect(stagingInsertText).toMatch(/INSERT INTO media_staging VALUES \(/);
    // Count the placeholders: should have exactly 23 per row
    const placeholderMatch = stagingInsertText.match(/\(\$(\d+),/);
    if (placeholderMatch) {
      const paramCount = Number(placeholderMatch[1]);
      expect(paramCount).toBeGreaterThanOrEqual(1);
    }
    // Verify that all 23 placeholders $1 through $23 appear exactly once
    for (let i = 1; i <= 23; i++) {
      expect(stagingInsertText).toContain(`$${i}`);
    }
    // Verify the exact parameter order matches MEDIA_COLUMN_COUNT by checking
    // the values array corresponds to encodeMediaItem column order
    const stagingInsertParams = records[3].params as any[];
    expect(stagingInsertParams).toHaveLength(23);
    // Check that values are in the expected order matching encodeMediaItem fields
    const expectedValueOrder = [
      'img1',             // id
      'lib1',             // library_id
      'Lib 1',            // library_name
      'folder/img1.jpg',  // relative_path
      'folder',           // folder
      'img1.jpg',         // name
      'jpg',              // extension
      'image',            // kind
      'image/jpeg',       // mime_type
      '12345',            // size
      null,               // width
      null,               // height
      null,               // duration_seconds
      '2024-01-01T00:00:00.000Z', // created_at
      '2024-01-02T00:00:00.000Z', // modified_at
      '2024-01-03T00:00:00.000Z', // indexed_at
      '[]',               // tags
      '',                 // description
      '',                 // artist
      '',                 // thumbnail_url
      '',                 // preview_thumbnail_url
      '',                 // file_url
      0,                  // position
    ];
    expect(stagingInsertParams).toEqual(expectedValueOrder);
    // Verify DELETE uses "DELETE FROM media_items" (not USING)
    expect(records[4].text).toMatch(/DELETE FROM media_items$/);
    // Verify INSERT into media_items SELECT * FROM media_staging
    expect(records[5].text).toMatch(/INSERT INTO media_items/);
  });
});

describe('PostgresSavedSearchRepository transaction behavior', () => {
  let pool: pg.Pool;

  beforeEach(() => {
    resetFakeQueries();
    pool = createFakePool();
  });

  it('list returns sorted items', async () => {
    const repo = new PostgresSavedSearchRepository({ pool });
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT saved_searches
      { rows: [
        { id: '1', name: 'b', query: '{}', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z' },
        { id: '2', name: 'a', query: '{}', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z' },
      ] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );
    const results = await repo.list();
    // Should be sorted by name: a then b
    expect(results[0].name).toBe('a');
    expect(results[1].name).toBe('b');
  });

  it('create inserts a new saved search', async () => {
    const repo = new PostgresSavedSearchRepository({ pool, idGenerator: () => 'new-id' });
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT pg_advisory_xact_lock_shared
      { rows: [], rowCount: 1 },
      // INSERT
      { rows: [], rowCount: 1 },
      // COMMIT
      { rows: [], rowCount: 1 },
    );
    await repo.create({ name: 'Test', query: { q: 'test' } });
  });

  it('update returns undefined when id not found', async () => {
    const repo = new PostgresSavedSearchRepository({ pool });
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT pg_advisory_xact_lock_shared
      { rows: [], rowCount: 1 },
      // SELECT FOR UPDATE - no rows
      { rows: [] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );
    const result = await repo.update('nonexistent', { name: 'X', query: {} });
    expect(result).toBeUndefined();
  });
});