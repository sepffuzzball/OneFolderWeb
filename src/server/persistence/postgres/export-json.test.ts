/**
 * Unit tests for exportPostgresToJson: repeatable-read transaction, output-dir
 * refusal before DB query (where practical), write failure cleanup, digest,
 * and reload through JSON repositories.
 *
 * Uses a fake pg.Pool with SQL recording to isolate from real DB.
 */

import pg from 'pg';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, MediaItem, SavedSearch } from '../../../shared/types.js';
import type { SettingsRepository, MediaIndexRepository, SavedSearchRepository, MediaIndex } from '../repositories.js';
import { ValidationError } from '../../validation.js';

// Import the export module
import { exportPostgresToJson } from './export-json.js';

// ---- Fake pool setup ----

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
  vi.spyOn(pool, 'connect').mockResolvedValue(createFakeClient() as any);
  return pool;
}

function createFakeClient(): Partial<pg.PoolClient> {
  const client: any = {
    query: async (text: string, params?: any[]) => {
      const errFn = fakeQueryError;
      if (errFn) {
        const err = errFn();
        if (err) throw err;
      }
      fakeQueryRecords.push({ text, params: params ?? [], result: fakeQuerySequence[fakeQueryIndex] });
      const result = fakeQuerySequence[fakeQueryIndex++];
      if (!result) throw new Error('No more fake query results');
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

function resetFakeQueries() {
  fakeQueryRecords = [];
  fakeQuerySequence = [];
  fakeQueryIndex = 0;
  fakeQueryError = undefined;
}

function setFakeQueryResults(...results: FakeQueryResult[]) {
  fakeQuerySequence = results;
}

function getRecordedQueries(): FakeQueryRecord[] {
  return fakeQueryRecords;
}

// ---- Test helpers ----

function makeSettings(): AppSettings {
  return {
    libraries: [
      { id: 'lib1', name: 'Library 1', path: '/data', enabled: true, startExpanded: false },
    ],
    tagCatalog: ['tag1', 'tag2'],
    tagAliases: { tag1: ['alias1'] },
  };
}

function makeMediaItemRow(id: string): any {
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
    size: '12345',
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

function makeSavedSearchRow(id: string): any {
  return {
    id,
    name: `Search ${id}`,
    query: JSON.stringify({ q: 'test' }),
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-02T00:00:00.000Z',
  };
}

function makeMigrationRow(name: string, checksum: string): any {
  return { name, checksum };
}

// ---- Tests ----

describe('exportPostgresToJson: repeatable-read transaction and query order', () => {
  beforeEach(() => {
    resetFakeQueries();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses REPEATABLE READ READ ONLY isolation level and queries tables in correct order', async () => {
    const pool = createFakePool();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT app_settings
      { rows: [{ id: 1, revision: 0, data: JSON.stringify(makeSettings()) }] },
      // SELECT media_index_state
      { rows: [{ id: 1, version: 1, generated_at: '2024-01-01T00:00:00.000Z' }] },
      // SELECT media_items
      { rows: [makeMediaItemRow('img1'), makeMediaItemRow('img2')] },
      // SELECT saved_searches
      { rows: [makeSavedSearchRow('s1'), makeSavedSearchRow('s2')] },
      // SELECT schema_migrations
      { rows: [makeMigrationRow('001-initial', 'abc'), makeMigrationRow('002-second', 'def')] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );

    const outputDir = '/tmp/export-test-order-' + randomUUID();
    // Ensure parent exists, but NOT the output dir - export creates it
    if (!fs.existsSync(path.dirname(outputDir))) fs.mkdirSync(path.dirname(outputDir), { recursive: true });

    const result = await exportPostgresToJson({
      pool,
      outputDir,
      defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
      defaultLibraryPath: '/tmp',
    });

    const records = getRecordedQueries();
    // Verify first query is BEGIN with repeatable read
    expect(records[0].text).toMatch(/BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/);

    // Verify query order: app_settings, media_index_state, media_items, saved_searches, schema_migrations
    // Note: queries use parameterized $1 placeholders, so match on table names
    expect(records[1].text).toMatch(/FROM app_settings WHERE/);
    expect(records[2].text).toMatch(/FROM media_index_state WHERE/);
    expect(records[3].text).toMatch(/FROM media_items ORDER BY/);
    expect(records[4].text).toMatch(/FROM saved_searches ORDER BY/);
    expect(records[5].text).toMatch(/FROM schema_migrations ORDER BY/);
    expect(records[6].text).toBe('COMMIT');

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});

describe('exportPostgresToJson: rollback/release on failure', () => {
  beforeEach(() => {
    resetFakeQueries();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back on query error and releases client', async () => {
    const releaseFn = vi.fn();
    const pool = new pg.Pool();
    vi.spyOn(pool, 'connect').mockImplementation(async () => {
      const client: any = {
        query: async (text: string) => {
          fakeQueryRecords.push({ text, params: [], result: { rows: [] } });
          // Throw on the app_settings query (second query after BEGIN)
          if (fakeQueryRecords.length === 2) {
            throw new Error('query failure');
          }
          return { rows: [] };
        },
        release: releaseFn,
      };
      return client;
    });

    await expect(
      exportPostgresToJson({
        pool,
        outputDir: '/tmp/export-test-fail-' + randomUUID(),
        defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
        defaultLibraryPath: '/tmp',
      }),
    ).rejects.toThrow('query failure');

    // Should have a ROLLBACK query
    const rollbacks = fakeQueryRecords.filter((r) => r.text === 'ROLLBACK');
    expect(rollbacks.length).toBeGreaterThanOrEqual(1);

    // Release should be called once
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });
});

describe('exportPostgresToJson: output directory refusal', () => {
  beforeEach(() => {
    resetFakeQueries();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses to export when outputDir already exists and is non-empty', async () => {
    const outputDir = '/tmp/export-test-exists-' + randomUUID();
    // Create the output directory with a mock file
    if (!fs.existsSync(path.dirname(outputDir))) fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'placeholder.txt'), 'x');

    // No fake queries needed - check happens before DB connection
    await expect(
      exportPostgresToJson({
        pool: createFakePool(),
        outputDir,
        defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
        defaultLibraryPath: '/tmp',
      }),
    ).rejects.toThrow(/already exists/);

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('refuses to export when outputDir already exists but is empty', async () => {
    const outputDir = '/tmp/export-test-empty-' + randomUUID();
    // Create empty directory (but it already exists, so mkdir exclusive fails)
    if (!fs.existsSync(path.dirname(outputDir))) fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    // No fake queries needed - check happens before DB connection
    await expect(
      exportPostgresToJson({
        pool: createFakePool(),
        outputDir,
        defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
        defaultLibraryPath: '/tmp',
      }),
    ).rejects.toThrow(/already exists/);

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});

describe('exportPostgresToJson: write failure cleanup', () => {
  beforeEach(() => {
    resetFakeQueries();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cleans up the staging directory on write failure', async () => {
    // Make the first writeFile call (settings.json) fail by having fs.promises.rename throw
    const pool = createFakePool();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT app_settings
      { rows: [{ id: 1, revision: 0, data: JSON.stringify(makeSettings()) }] },
      // SELECT media_index_state
      { rows: [{ id: 1, version: 1, generated_at: '2024-01-01T00:00:00.000Z' }] },
      // SELECT media_items
      { rows: [makeMediaItemRow('img1')] },
      // SELECT saved_searches
      { rows: [makeSavedSearchRow('s1')] },
      // SELECT schema_migrations
      { rows: [makeMigrationRow('001-initial', 'abc')] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );

    const outputDir = '/tmp/export-test-cleanup-' + randomUUID();
    // Ensure parent exists, but NOT the output dir - export creates it
    if (!fs.existsSync(path.dirname(outputDir))) fs.mkdirSync(path.dirname(outputDir), { recursive: true });

    // Spy on rename to throw on first call (simulates rename failure after write succeeds)
    const renameOriginal = fs.promises.rename;
    let renameCallCount = 0;
    const renameSpy = vi.fn().mockImplementation(async (from, to) => {
      renameCallCount++;
      if (renameCallCount === 1) {
        throw new Error('simulated rename failure');
      }
      // For subsequent calls (index.json, etc.), succeed
      return undefined;
    });
    vi.spyOn(fs.promises, 'rename').mockImplementation(renameSpy as any);

    await expect(
      exportPostgresToJson({
        pool,
        outputDir,
        defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
        defaultLibraryPath: '/tmp',
      }),
    ).rejects.toThrow('simulated rename failure');

    // Restore original rename
    vi.spyOn(fs.promises, 'rename').mockImplementation(renameOriginal as any);

    // The output directory should not exist after cleanup (staging was cleaned)
    expect(fs.existsSync(outputDir)).toBe(false);
  });
});

describe('exportPostgresToJson: digest verification', () => {
  beforeEach(() => {
    resetFakeQueries();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes the correct digest for exported data', async () => {
    const pool = createFakePool();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT app_settings
      { rows: [{ id: 1, revision: 0, data: JSON.stringify(makeSettings()) }] },
      // SELECT media_index_state
      { rows: [{ id: 1, version: 1, generated_at: '2024-01-01T00:00:00.000Z' }] },
      // SELECT media_items
      { rows: [makeMediaItemRow('img1')] },
      // SELECT saved_searches
      { rows: [makeSavedSearchRow('s1')] },
      // SELECT schema_migrations
      { rows: [makeMigrationRow('001-initial', 'abc')] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );

    const outputDir = '/tmp/export-test-digest-' + randomUUID();
    // Ensure parent exists, but NOT the output dir - export creates it
    if (!fs.existsSync(path.dirname(outputDir))) fs.mkdirSync(path.dirname(outputDir), { recursive: true });

    const result = await exportPostgresToJson({
      pool,
      outputDir,
      defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
      defaultLibraryPath: '/tmp',
    });

    // Verify manifest.json contains the digest
    const manifestText = fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    expect(manifest.semanticDigest).toBe(result.digest);

    // The existing computeDigest function should produce the same digest
    const { computeDigest } = await import('./import-json.js');

    // Reconstruct the inputs from the written files
    const settings: AppSettings = JSON.parse(fs.readFileSync(path.join(outputDir, 'settings.json'), 'utf8'));
    const mediaIndex: MediaIndex = JSON.parse(fs.readFileSync(path.join(outputDir, 'index.json'), 'utf8'));
    const savedSearches: SavedSearch[] = JSON.parse(fs.readFileSync(path.join(outputDir, 'saved-searches.json'), 'utf8')).items;

    // Compute digest manually
    const manualDigest = computeDigest(settings, mediaIndex, savedSearches);
    expect(manualDigest).toBe(result.digest);

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
  });
});

describe('exportPostgresToJson: reload through JSON repositories', () => {
  beforeEach(() => {
    resetFakeQueries();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reloads exported data through JSON repositories and preserves values', async () => {
    const pool = createFakePool();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT app_settings
      { rows: [{ id: 1, revision: 0, data: JSON.stringify(makeSettings()) }] },
      // SELECT media_index_state
      { rows: [{ id: 1, version: 1, generated_at: '2024-01-01T00:00:00.000Z' }] },
      // SELECT media_items
      { rows: [makeMediaItemRow('img1'), makeMediaItemRow('img2')] },
      // SELECT saved_searches
      { rows: [makeSavedSearchRow('s1'), makeSavedSearchRow('s2')] },
      // SELECT schema_migrations
      { rows: [makeMigrationRow('001-initial', 'abc')] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );

    const outputDir = '/tmp/export-test-reload-' + randomUUID();
    // Ensure parent exists, but NOT the output dir - export creates it
    if (!fs.existsSync(path.dirname(outputDir))) fs.mkdirSync(path.dirname(outputDir), { recursive: true });

    const result = await exportPostgresToJson({
      pool,
      outputDir,
      defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
      defaultLibraryPath: '/tmp',
    });

    // Now verify that loading through JSON repositories gives the same values
    const { JsonSettingsRepository, JsonMediaIndexRepository, JsonSavedSearchRepository } = await import('../json.js');

    const settingsRepo = new JsonSettingsRepository({
      primaryPath: path.join(outputDir, 'settings.json'),
      backupDir: '',
      backupRetentionDays: 0,
      backupIntervalHours: 0,
      defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
      defaultLibraryPath: '/tmp',
    });
    const loadedSettings = await settingsRepo.load();
    expect(loadedSettings.libraries[0].id).toBe('lib1');
    expect(loadedSettings.tagCatalog).toEqual(['tag1', 'tag2']);

    const mediaRepo = new JsonMediaIndexRepository({
      primaryPath: path.join(outputDir, 'index.json'),
      backupDir: '',
      backupRetentionDays: 0,
      backupIntervalHours: 0,
      defaultIndex: () => ({ version: 1, generatedAt: '', files: [] }),
    });
    const loadedMedia = await mediaRepo.load();
    expect(loadedMedia.files.length).toBe(2);
    expect(loadedMedia.files[0].id).toBe('img1');

    const savedRepo = new JsonSavedSearchRepository({
      primaryPath: path.join(outputDir, 'saved-searches.json'),
    });
    const loadedSearches = await savedRepo.list();
    expect(loadedSearches.length).toBe(2);
    expect(loadedSearches[0].name).toBe('Search s1');

    // Cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it('race condition: if final directory created during writes, fails and cleans staging', async () => {
    const pool = createFakePool();
    setFakeQueryResults(
      // BEGIN
      { rows: [], rowCount: 1 },
      // SELECT app_settings
      { rows: [{ id: 1, revision: 0, data: JSON.stringify(makeSettings()) }] },
      // SELECT media_index_state
      { rows: [{ id: 1, version: 1, generated_at: '2024-01-01T00:00:00.000Z' }] },
      // SELECT media_items
      { rows: [makeMediaItemRow('img1')] },
      // SELECT saved_searches
      { rows: [makeSavedSearchRow('s1')] },
      // SELECT schema_migrations
      { rows: [makeMigrationRow('001-initial', 'abc')] },
      // COMMIT
      { rows: [], rowCount: 1 },
    );

    const outputDir = '/tmp/export-test-race-' + randomUUID();
    // Ensure parent exists, but NOT the output dir at start
    if (!fs.existsSync(path.dirname(outputDir))) fs.mkdirSync(path.dirname(outputDir), { recursive: true });

    // Spy on existsSync to simulate the outputDir being created after staging writes
    const existsOriginal = fs.existsSync;
    let existsCallCount = 0;
    vi.spyOn(fs, 'existsSync').mockImplementation((dirPath: any) => {
      existsCallCount++;
      // After the first exists check (which is the initial check at step 0), and after staging has been created,
      // we make the outputDir "exist" to trigger the race at the re-check step
      if (existsCallCount === 3) {
        // Simulate outputDir created during writes
        fs.mkdirSync(outputDir, { recursive: true });
        // Return true for the re-check
        return true;
      }
      return existsOriginal.call(fs, dirPath);
    });

    // Expect the export to fail because outputDir was created during writes
    await expect(
      exportPostgresToJson({
        pool,
        outputDir,
        defaultSettings: () => ({ libraries: [], tagCatalog: [], tagAliases: {} }),
        defaultLibraryPath: '/tmp',
      }),
    ).rejects.toThrow(/Output directory.*was created during export/);

    // Restore existsSync
    vi.spyOn(fs, 'existsSync').mockImplementation(existsOriginal as any);

    // Verify staging directory does not exist (cleaned up)
    // The staging dir is under parent, with pattern <basename>.staging-<uuid>
    // We can only check that parent does not contain any staging dir
    const parent = path.dirname(outputDir);
    const stagingDirs = fs.readdirSync(parent).filter((d) => d.startsWith(path.basename(outputDir) + '.staging-'));
    expect(stagingDirs.length).toBe(0);
  });
});
