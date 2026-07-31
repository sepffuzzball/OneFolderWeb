/**
 * Persistence tests for JSON repository implementations.
 *
 * Filesystem-isolated: each test creates a temp root, creates controlled
 * directories and files, then imports the repository classes with explicit
 * options so tests never mutate global config.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import type { AppSettings, MediaItem } from '../../shared/types.js';

// Import repository types and implementations
import { atomicReplace, JsonSettingsRepository, JsonMediaIndexRepository } from './json.js';
import { settingsRepository, mediaIndexRepository } from './json.js';

// ---- Helper functions -------------------------------------------------------

/** Create a temporary root directory for each test. */
function testRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oftest-persistence-'));
}

/** Write a JSON file and return its absolute path. */
function writeJson(filePath: string, obj: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`);
}

/** Read a JSON file as string. */
function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

/** Return parsed JSON from a file. */
function readJson<T>(filePath: string): T {
  return JSON.parse(readFile(filePath)) as T;
}

/** Return entry names in a directory (sorted). */
function dirEntries(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Paths within a temp root. */
function testPaths(root: string): {
  settingsPrimary: string;
  indexPrimary: string;
  backupDir: string;
} {
  const settingsDir = path.join(root, 'settings');
  const indexDir = path.join(root, 'index');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.mkdirSync(indexDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  return {
    settingsPrimary: path.join(settingsDir, 'settings.json'),
    indexPrimary: path.join(indexDir, 'index.json'),
    backupDir,
  };
}

/** Create a JsonSettingsRepository with test-specific options. */
function makeSettingsRepo(
  root: string,
  overrides?: Partial<{
    defaultLibraryPath: string;
    replaceFile: (targetPath: string, content: string) => Promise<void>;
  }>,
): JsonSettingsRepository {
  const opts = testPaths(root);
  return new JsonSettingsRepository({
    primaryPath: opts.settingsPrimary,
    backupDir: opts.backupDir,
    backupRetentionDays: 90,
    backupIntervalHours: 24,
    defaultSettings: () => ({
      libraries: [{ id: 'default', name: 'Library', path: root, enabled: true, startExpanded: true }],
      tagCatalog: [],
      tagAliases: {},
    }),
    defaultLibraryPath: root,
    ...overrides,
  });
}

/** Create a JsonMediaIndexRepository with test-specific options. */
function makeIndexRepo(
  root: string,
  overrides?: Partial<{
    replaceFile: (targetPath: string, content: string) => Promise<void>;
  }>,
): JsonMediaIndexRepository {
  const opts = testPaths(root);
  return new JsonMediaIndexRepository({
    primaryPath: opts.indexPrimary,
    backupDir: opts.backupDir,
    backupRetentionDays: 90,
    backupIntervalHours: 24,
    defaultIndex: () => ({
      version: 1,
      generatedAt: new Date(0).toISOString(),
      files: [],
    }),
    ...overrides,
  });
}

/**
 * Create a simple MediaItem for testing.
 */
function makeMediaItem(id: string, tags: string[] = []): MediaItem {
  return {
    id,
    libraryId: 'test-lib',
    libraryName: 'Test Library',
    relativePath: `some/${id}.jpg`,
    folder: 'some',
    name: `${id}.jpg`,
    extension: 'jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    size: 12345,
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    indexedAt: new Date().toISOString(),
    tags,
    description: '',
    artist: '',
    thumbnailUrl: '',
    previewThumbnailUrl: '',
    fileUrl: '',
  };
}

// ---- Actual tests -----------------------------------------------------------

describe('JsonSettingsRepository', () => {
  let root: string;
  let repo: JsonSettingsRepository;

  beforeEach(() => {
    root = testRoot();
    repo = makeSettingsRepo(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('load returns default settings when no file exists', async () => {
    const settings = await repo.load();
    expect(settings.libraries).toBeDefined();
    expect(settings.libraries.length).toBe(1);
    expect(settings.libraries[0].id).toBe('default');
    expect(settings.libraries[0].name).toBe('Library');
    expect(settings.libraries[0].path).toBe(root);
  });

  it('load normalizes settings from file', async () => {
    const { settingsPrimary } = testPaths(root);
    writeJson(settingsPrimary, {
      libraries: [
        {
          id: 'lib1',
          name: 'Lib 1',
          path: root,
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['a', 'b', 'c'],
      tagAliases: { a: ['b', 'c'] },
    });
    const settings = await repo.load();
    expect(settings.libraries[0].name).toBe('Lib 1');
    expect(settings.libraries[0].id).toBe('lib1');
    expect(settings.tagCatalog).toEqual(['a', 'b', 'c']);
    // tagAliases should be normalized
    expect(settings.tagAliases).toEqual({ a: ['b', 'c'] });
  });

  it('save preserves exact JSON format with trailing newline', async () => {
    const testSettings: AppSettings = {
      libraries: [
        {
          id: 'lib1',
          name: 'Lib 1',
          path: root,
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['t1'],
      tagAliases: {},
    };
    await repo.save(testSettings);
    const { settingsPrimary } = testPaths(root);
    const raw = readFile(settingsPrimary);
    // Ensure pretty JSON with trailing newline
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed).toBeDefined();
  });

  it('save normalizes before writing', async () => {
    const initial: AppSettings = {
      libraries: [
        {
          id: undefined!,
          name: '',
          path: '/nonexistent',
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['a', '', 'B', 'b'],
      tagAliases: { '': [''] },
    };
    await repo.save(initial);
    const { settingsPrimary } = testPaths(root);
    const raw = readFile(settingsPrimary);
    const parsed = JSON.parse(raw) as AppSettings;
    expect(parsed.libraries[0].id).toBeTruthy();
    expect(parsed.libraries[0].name).toBeTruthy();
    // Normalization preserves case; only empty entries removed.
    expect(parsed.tagCatalog).toEqual(['a', 'b', 'B']);
    expect(parsed.tagAliases).toEqual({});
  });

  it('update rejects when mutator throws but recovery works', async () => {
    const testSettings: AppSettings = {
      libraries: [
        {
          id: 'lib1',
          name: 'Lib 1',
          path: root,
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['t1'],
      tagAliases: {},
    };
    await repo.save(testSettings);

    const updatePromise = repo.update(() => {
      throw new Error('simulated failure');
    });
    await expect(updatePromise).rejects.toThrow('simulated failure');

    // After rejection, the next operation should succeed.
    const next = await repo.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 't2'],
    }));
    expect(next.tagCatalog).toContain('t2');
  });

  it('update is side-effect-free and returns normalized', async () => {
    const initial: AppSettings = {
      libraries: [
        {
          id: 'lib1',
          name: 'Lib 1',
          path: root,
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['t1'],
      tagAliases: {},
    };
    await repo.save(initial);
    const updated = await repo.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 't2'],
    }));
    // The returned value minus the update.
    expect(updated.tagCatalog).toContain('t2');
    // The underlying file should also have t2.
    const { settingsPrimary } = testPaths(root);
    const raw = readFile(settingsPrimary);
    const parsed = JSON.parse(raw) as AppSettings;
    expect(parsed.tagCatalog).toContain('t2');
  });
});

describe('JsonMediaIndexRepository', () => {
  let root: string;
  let repo: JsonMediaIndexRepository;

  beforeEach(() => {
    root = testRoot();
    repo = makeIndexRepo(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('load returns default index when no file exists', async () => {
    const index = await repo.load();
    expect(index.version).toBe(1);
    expect(index.generatedAt).toBeDefined();
    expect(index.files).toEqual([]);
  });

  it('save preserves exact JSON format with trailing newline', async () => {
    const files = [makeMediaItem('img1')];
    await repo.save(files as readonly MediaItem[]);
    const { indexPrimary } = testPaths(root);
    const raw = readFile(indexPrimary);
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.generatedAt).toBeDefined();
    expect(parsed.files).toHaveLength(1);
  });

  it('stable backup format omits generatedAt', async () => {
    const { backupDir, indexPrimary } = testPaths(root);
    writeJson(indexPrimary, {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: [makeMediaItem('img1')],
    });

    const repo2 = new JsonMediaIndexRepository({
      primaryPath: indexPrimary,
      backupDir,
      backupRetentionDays: 90,
      backupIntervalHours: 24,
      defaultIndex: () => ({
        version: 1,
        generatedAt: new Date(0).toISOString(),
        files: [],
      }),
    });

    await repo2.save([makeMediaItem('img1')] as readonly MediaItem[]);
    const backups = dirEntries(backupDir);
    expect(backups.length).toBeGreaterThan(0);
    const backupRaw = readFile(path.join(backupDir, backups[0]));
    const backupParsed = JSON.parse(backupRaw);
    // Should omit generatedAt
    expect(backupParsed).not.toHaveProperty('generatedAt');
    expect(backupParsed.version).toBe(1);
    expect(backupParsed.files).toHaveLength(1);
  });

  it('dedupe backup on same content', async () => {
    const { backupDir } = testPaths(root);
    const files = [makeMediaItem('img1')];
    await repo.save(files as readonly MediaItem[]);
    const backupCountBefore = dirEntries(backupDir).length;
    await repo.save(files as readonly MediaItem[]);
    const backupCountAfter = dirEntries(backupDir).length;
    // Should not create extra backup if content identical
    expect(backupCountAfter).toBe(backupCountBefore);
  });

  it('load returns normalized index with version 1 on missing file', async () => {
    const index = await repo.load();
    expect(index.version).toBe(1);
    expect(index.generatedAt).toBe(new Date(0).toISOString());
  });

  it('save preserves generatedAt in primary but removes in backup', async () => {
    const files = [makeMediaItem('img1')];
    const saved = await repo.save(files as readonly MediaItem[]);
    // Primary has generatedAt
    expect(saved.generatedAt).toBeDefined();
    // Backup should omit generatedAt (stable format)
    const { backupDir, indexPrimary } = testPaths(root);
    const backups = dirEntries(backupDir);
    if (backups.length > 0) {
      const backupRaw = readFile(path.join(backupDir, backups[0]));
      const backupParsed = JSON.parse(backupRaw);
      expect(backupParsed).not.toHaveProperty('generatedAt');
    }
  });
});

describe('concurrent operations and shared lock', () => {
  let root: string;
  let repo1: JsonSettingsRepository;
  let repo2: JsonSettingsRepository;

  beforeEach(() => {
    root = testRoot();
    repo1 = makeSettingsRepo(root);
    repo2 = makeSettingsRepo(root);
  });

  afterEach(() => {
    // Recursively restore permissions before cleanup.
    try {
      const fixPerms = (dir: string) => {
        try {
          fs.chmodSync(dir, 0o755);
        } catch {
          // ignore
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) fixPerms(path.join(dir, entry.name));
        }
      };
      fixPerms(root);
    } catch {
      // ignore
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('two concurrent updates to the same repo compose without lost updates', async () => {
    await repo1.save({
      libraries: [
        {
          id: 'lib1',
          name: 'Lib 1',
          path: root,
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['a'],
      tagAliases: {},
    } as AppSettings);

    // Concurrent updates
    const update1 = repo1.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 'b'],
    }));
    const update2 = repo1.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 'c'],
    }));

    await Promise.all([update1, update2]);

    const final = await repo1.load();
    // Should contain both b and c without lost update
    expect(final.tagCatalog).toContain('a');
    expect(final.tagCatalog).toContain('b');
    expect(final.tagCatalog).toContain('c');
  });

  it('two repositories targeting the same primary path share the lock', async () => {
    await repo1.save({
      libraries: [
        {
          id: 'lib1',
          name: 'Lib 1',
          path: root,
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['a'],
      tagAliases: {},
    } as AppSettings);

    const update1 = repo1.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 'b'],
    }));
    const update2 = repo2.update((current) => ({
      ...current,
      tagCatalog: [...current.tagCatalog, 'c'],
    }));

    await Promise.all([update1, update2]);

    const final = await repo1.load();
    expect(final.tagCatalog).toContain('a');
    expect(final.tagCatalog).toContain('b');
    expect(final.tagCatalog).toContain('c');
  });

  it('legacy load fallback IDs and missing paths exactly match old behavior', async () => {
    const { settingsPrimary } = testPaths(root);
    // Write a file with missing id, missing name, empty path, and no enabled/startExpanded
    writeJson(settingsPrimary, {
      libraries: [
        {
          path: '',
        },
      ],
      tagCatalog: [],
      tagAliases: {},
    });
    const testRepo = makeSettingsRepo(root);
    const settings = await testRepo.load();
    // Missing id -> library-1, missing name -> Library 1
    expect(settings.libraries[0].id).toBe('library-1');
    expect(settings.libraries[0].name).toBe('Library 1');
    // Empty path -> default library path (root)
    expect(settings.libraries[0].path).toBe(root);
    // enabled and startExpanded default to true when not present in the file
    expect(settings.libraries[0].enabled).toBe(true);
    expect(settings.libraries[0].startExpanded).toBe(true);
  });

  it('legacy whitespace-only path resolves literally rather than falling back to default', async () => {
    const { settingsPrimary } = testPaths(root);
    // Write a file with a library path of three spaces
    writeJson(settingsPrimary, {
      libraries: [
        {
          id: 'lib1',
          name: 'Lib 1',
          path: '   ',
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: [],
      tagAliases: {},
    });
    const testRepo = makeSettingsRepo(root);
    const settings = await testRepo.load();
    // The three-space path is truthy (not empty), so it should resolve literally
    expect(settings.libraries[0].path).toBe(path.resolve('   '));
    // It should NOT fall back to the default library path (root)
    expect(settings.libraries[0].path).not.toBe(root);
  });

  it('a queued save snapshots input before later caller mutation', async () => {
    let blockerResolve: () => void;
    const blocker = new Promise<void>((resolve) => {
      blockerResolve = resolve;
    });
    const repoWithBlock = makeSettingsRepo(root, {
      replaceFile: async (targetPath, content) => {
        // Block until released
        await blocker;
        // Then proceed with normal atomic replace
        await atomicReplace(targetPath, content);
      },
    });
    const input = {
      libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }],
      tagCatalog: ['a'],
      tagAliases: {},
    } as AppSettings;
    const savePromise = repoWithBlock.save(input);
    // Mutate input after save is queued
    input.tagCatalog.push('b');
    // Release blocker
    blockerResolve!();
    await savePromise;
    const loaded = await repoWithBlock.load();
    // Should NOT contain 'b' which was pushed after save was enqueued.
    expect(loaded.tagCatalog).toEqual(['a']);
  });

  it('backup dedupe asserts backup replacement function is not called a second time for unchanged stable index content', async () => {
    let replaceCallCount = 0;
    function countReplace(targetPath: string, content: string): Promise<void> {
      replaceCallCount++;
      return atomicReplace(targetPath, content);
    }
    const indexRepo = makeIndexRepo(root, { replaceFile: countReplace });
    const files = [makeMediaItem('img1')];
    await indexRepo.save(files as readonly MediaItem[]);
    replaceCallCount = 0; // Reset count after primary+backup
    // Second save with same content should NOT call replaceFile for backup again
    await indexRepo.save(files as readonly MediaItem[]);
    // replaceCallCount should be 1 (primary write only; backup dedupe skipped)
    expect(replaceCallCount).toBe(1);
  });

  it('forced rename failure after temp write preserves an existing target content and leaves no PID/UUID temp files', async () => {
    const { settingsPrimary } = testPaths(root);
    // Write initial content
    writeJson(settingsPrimary, { libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }], tagCatalog: ['a'], tagAliases: {} });
    const initialContent = readFile(settingsPrimary);

    // Create a repo with a replaceFile that uses atomicReplace with a failing renameFile
    const failingRepo = makeSettingsRepo(root, {
      replaceFile: (targetPath, content) =>
        atomicReplace(targetPath, content, {
          renameFile: async (_from, _to) => {
            throw new Error('simulated rename failure');
          },
        }),
    });
    // Ignore the error; we only care about side effects
    await expect(failingRepo.save({
      libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }],
      tagCatalog: ['b'],
      tagAliases: {},
    } as AppSettings)).rejects.toThrow('simulated rename failure');
    // Target content should remain unchanged
    const afterContent = readFile(settingsPrimary);
    expect(afterContent).toBe(initialContent);
    // No temp files should remain in the directory
    const dirEntriesAfter = dirEntries(path.dirname(settingsPrimary));
    const tempFiles = dirEntriesAfter.filter((name) => name.includes(`${process.pid}`));
    expect(tempFiles.length).toBe(0);
  });

  it('forced primary replacement failure rejects that operation and later same-key save succeeds', async () => {
    const { settingsPrimary } = testPaths(root);
    let failPrimary = true;
    const overrides = {
      replaceFile: async (targetPath: string, content: string) => {
        if (targetPath === settingsPrimary && failPrimary) {
          failPrimary = false;
          throw new Error('simulated primary failure');
        }
        await atomicReplace(targetPath, content);
      },
    };
    const settingsRepo = makeSettingsRepo(root, { ...overrides, defaultLibraryPath: root });

    // First save should fail
    await expect(settingsRepo.save({
      libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }],
      tagCatalog: ['a'],
      tagAliases: {},
    } as AppSettings)).rejects.toThrow('simulated primary failure');
    // Later same-key save should succeed
    const second = await settingsRepo.save({
      libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }],
      tagCatalog: ['b'],
      tagAliases: {},
    } as AppSettings);
    expect(second.tagCatalog).toEqual(['b']);
  });

  it('forced backup replacement failure rejects after primary is committed; then later same-key operation succeeds', async () => {
    const { backupDir, settingsPrimary } = testPaths(root);
    let failBackup = true;
    const overrides = {
      replaceFile: async (targetPath: string, content: string) => {
        // Target a backup file (starts with settings-)
        if (targetPath.startsWith(backupDir) && failBackup) {
          failBackup = false;
          throw new Error('simulated backup failure');
        }
        await atomicReplace(targetPath, content);
      },
    };
    const settingsRepo = makeSettingsRepo(root, { ...overrides, defaultLibraryPath: root });

    // First save backup should fail (primary succeeds)
    await expect(settingsRepo.save({
      libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }],
      tagCatalog: ['a'],
      tagAliases: {},
    } as AppSettings)).rejects.toThrow('simulated backup failure');
    // Assert the primary was committed despite backup failure
    const primaryAfterRejection = readFile(settingsPrimary);
    const parsedAfterRejection = JSON.parse(primaryAfterRejection);
    expect(parsedAfterRejection.tagCatalog).toEqual(['a']);

    // Later same-key operation should succeed
    const second = await settingsRepo.save({
      libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }],
      tagCatalog: ['c'],
      tagAliases: {},
    } as AppSettings);
    expect(second.tagCatalog).toEqual(['c']);
  });

  it('a load invoked after an already-queued save returns the saved value', async () => {
    let delayedResolve: () => void;
    const delayed = new Promise<void>((resolve) => { delayedResolve = resolve; });
    const delayedRepo = makeSettingsRepo(root, {
      replaceFile: async (targetPath, content) => {
        await delayed;
        await atomicReplace(targetPath, content);
      },
    });
    const input = {
      libraries: [{ id: 'lib1', name: 'Lib 1', path: root, enabled: true, startExpanded: false }],
      tagCatalog: ['saved'],
      tagAliases: {},
    } as AppSettings;
    const savePromise = delayedRepo.save(input);
    // Load is queued after save; should see the saved value after it completes
    const loadPromise = delayedRepo.load();
    delayedResolve!();
    await savePromise;
    const loaded = await loadPromise;
    expect(loaded.tagCatalog).toEqual(['saved']);
  });
});
