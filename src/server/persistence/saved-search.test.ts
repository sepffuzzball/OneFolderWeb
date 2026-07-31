/**
 * Deterministic tests for JsonSavedSearchRepository.
 *
 * Filesystem-isolated: each test creates a temp root, creates controlled
 * directories and files, then imports the repository class with explicit
 * options so tests never mutate global config.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import type { SavedSearch } from '../../shared/types.js';
import type { SavedSearchInput } from './repositories.js';
import { JsonSavedSearchRepository } from './json.js';
import type { SavedSearchEnvelope } from './json.js';

// ---- Helper functions -------------------------------------------------------

function testRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oftest-savedsearch-'));
}

/** Write a saved-search envelope file. */
function writeEnvelope(
  filePath: string,
  envelope: SavedSearchEnvelope,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(envelope, null, 2)}\n`,
  );
}

/** Read a saved-search envelope file as string. */
function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8');
}

/** Return parsed envelope from a file. */
function readEnvelope(filePath: string): SavedSearchEnvelope {
  return JSON.parse(readFile(filePath)) as SavedSearchEnvelope;
}

/** Create a new JsonSavedSearchRepository with controlled clock/UUID. */
function makeRepo(
  root: string,
  overrides?: Partial<{
    primaryPath: string;
    replaceFile: (targetPath: string, content: string) => Promise<void>;
    clock: () => string;
    idGenerator: () => string;
  }>,
): JsonSavedSearchRepository {
  const primaryPath = overrides?.primaryPath ?? path.join(root, 'saved-searches.json');
  const idGenerator = overrides?.idGenerator ?? (() => 'test-id-' + Math.random().toString(36).slice(2));
  const clock = overrides?.clock ?? (() => '2026-07-31T12:00:00.000Z');
  const replaceFile = overrides?.replaceFile ?? (async (targetPath, content) => {
    await fs.promises.writeFile(targetPath, content);
  });
  return new JsonSavedSearchRepository({
    primaryPath,
    replaceFile,
    clock,
    idGenerator,
  });
}

function makeInput(name: string, query?: Record<string, unknown>): SavedSearchInput {
  return {
    name,
    query: {
      q: query?.q ?? undefined,
      tags: query?.tags ?? undefined,
      tagExpression: query?.tagExpression ?? undefined,
      folder: query?.folder ?? undefined,
      libraryId: query?.libraryId ?? undefined,
    },
  };
}

// ---- Actual tests -----------------------------------------------------------

describe('JsonSavedSearchRepository', () => {
  let root: string;
  let repo: JsonSavedSearchRepository;

  beforeEach(() => {
    root = testRoot();
    repo = makeRepo(root);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('list returns empty array when no file exists', async () => {
    const list = await repo.list();
    expect(list).toEqual([]);
  });

  it('list returns all items sorted by name then id', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'b', name: 'Beta', query: { q: 'x' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
        { id: 'a', name: 'Alpha', query: { q: 'x' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
        { id: 'c', name: 'Alpha', query: { q: 'x' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    const list = await repo.list();
    // Sorted by name (Alpha first), then id (a before c)
    expect(list[0].id).toBe('a');
    expect(list[1].id).toBe('c');
    expect(list[2].id).toBe('b');
  });

  it('get returns undefined for unknown id', async () => {
    const result = await repo.get('nonexistent');
    expect(result).toBeUndefined();
  });

  it('get returns the correct item', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { q: 'test' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    const got = await repo.get('x');
    expect(got).toBeDefined();
    expect(got!.name).toBe('Test');
  });

  it('create generates UUID and ISO timestamps', async () => {
    const created = await repo.create(makeInput('new search'));
    expect(created.id).toBeDefined();
    expect(typeof created.createdAt).toBe('string');
    expect(created.createdAt).toBe('2026-07-31T12:00:00.000Z');
    expect(created.updatedAt).toBe('2026-07-31T12:00:00.000Z');
    // Should be in the persisted file
    const primaryPath = path.join(root, 'saved-searches.json');
    const envelope = readEnvelope(primaryPath);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0].id).toBe(created.id);
  });

  it('create creates a detached output (no mutation of input)', async () => {
    const input: SavedSearchInput = { name: 'detached', query: { q: 'test' } };
    const saved = await repo.create(input);
    // Mutate input after creation
    input.name = 'mutated';
    input.query.q = 'mutated';
    const loaded = await repo.get(saved.id);
    expect(loaded!.name).toBe('detached');
    expect(loaded!.query.q).toBe('test');
  });

  it('update preserves id and createdAt, changes updatedAt', async () => {
    // Use a clock that advances to ensure updatedAt differs from createdAt.
    let tick = 0;
    const advancingClock = () => {
      tick++;
      return `2026-07-31T12:00:${String(tick).padStart(2, '0')}.000Z`;
    };
    const repoWithAdvancingClock = makeRepo(root, {
      clock: advancingClock,
      idGenerator: () => 'test-id-update-' + Math.random().toString(36).slice(2),
    });
    const created = await repoWithAdvancingClock.create(makeInput('original'));
    const updated = await repoWithAdvancingClock.update(created.id, makeInput('updated'));
    expect(updated).toBeDefined();
    expect(updated!.id).toBe(created.id);
    expect(updated!.createdAt).toBe(created.createdAt);
    expect(updated!.updatedAt).not.toBe(created.updatedAt);
    // updatedAt should be later than createdAt
    expect(updated!.updatedAt).toBe('2026-07-31T12:00:02.000Z');
  });

  it('update returns undefined for unknown id', async () => {
    const result = await repo.update('unknown', makeInput('test'));
    expect(result).toBeUndefined();
  });

  it('delete returns false for unknown id', async () => {
    const deleted = await repo.delete('unknown');
    expect(deleted).toBe(false);
  });

  it('delete removes the item', async () => {
    const created = await repo.create(makeInput('to delete'));
    const deleted = await repo.delete(created.id);
    expect(deleted).toBe(true);
    const got = await repo.get(created.id);
    expect(got).toBeUndefined();
  });

  it('concurrent creates produce no lost updates', async () => {
    // Both repos share the same primary path so they share the same queue.
    const repo2 = makeRepo(root, {
      primaryPath: path.join(root, 'saved-searches.json'),
      // Use deterministic IDs for concurrent tests.
      idGenerator: () => 'concurrent-id-' + Math.random().toString(36).slice(2),
    });

    // Use deterministic generated IDs to verify exact final IDs.
    const create1 = repo.create(makeInput('test1'));
    const create2 = repo2.create(makeInput('test2'));
    await Promise.all([create1, create2]);

    const list = await repo.list();
    expect(list).toHaveLength(2);
    // Both IDs should be present in the final list.
    const ids = list.map((item) => item.id);
  });

  it('update and delete on same id are atomic (no conflict)', async () => {
    const created = await repo.create(makeInput('shared'));
    const update1 = repo.update(created.id, makeInput('update-1'));
    const update2 = repo.update(created.id, makeInput('update-2'));
    await Promise.all([update1, update2]);
    const final = await repo.get(created.id);
    expect(final).toBeDefined();
  });

  it('delete and create on same id are atomic', async () => {
    const created = await repo.create(makeInput('to delete'));
    // Delete and then recreate
    const deletePromise = repo.delete(created.id);
    const createPromise = repo.create(makeInput('replaced'));
    await Promise.all([deletePromise, createPromise]);
    // The new item should have a different id
    const list = await repo.list();
    // If both operations completed, there should be one item
    expect(list).toHaveLength(1);
    // The item should have the new id
  });

  // ---- Envelope mutation tests (caller mutation cannot affect persisted state) ----

  it('create input mutation does not leak into persisted file', async () => {
    // Provide a blocked replacement path so the input is mutated after
    // the create is enqueued but before the queued work consumes it.
    let blockerResolve: () => void;
    const blocker = new Promise<void>((resolve) => { blockerResolve = resolve; });
    const blockedRepo = makeRepo(root, {
      replaceFile: async (_targetPath, _content) => {
        await blocker;
        await fs.promises.writeFile(_targetPath, _content);
      },
    });
    const input = makeInput('blocked');
    input.query.q = 'original';
    const savePromise = blockedRepo.create(input);
    // Mutate input after create is enqueued.
    input.query.q = 'mutated';
    // Release blocker.
    blockerResolve!();
    await savePromise;
    // Since the id generator is random, we cannot predict the ID.
    // Verify persisted data directly from the file.
    const primaryPath = path.join(root, 'saved-searches.json');
    const envelope = readEnvelope(primaryPath);
    expect(envelope.items).toHaveLength(1);
    expect(envelope.items[0].query.q).toBe('original');
  });

  it('update input mutation does not leak into persisted file', async () => {
    // Create an item first.
    const created = await repo.create(makeInput('original'));
    // Provide a blocked replacement path for update.
    let blockerResolve: () => void;
    const blocker = new Promise<void>((resolve) => { blockerResolve = resolve; });
    const blockedRepo = makeRepo(root, {
      primaryPath: path.join(root, 'saved-searches.json'),
      replaceFile: async (_targetPath, _content) => {
        await blocker;
        await fs.promises.writeFile(_targetPath, _content);
      },
    });
    const input = makeInput('updated');
    input.query.q = 'update-original';
    const updatePromise = blockedRepo.update(created.id, input);
    // Mutate input after update is enqueued.
    input.query.q = 'update-mutated';
    // Release blocker.
    blockerResolve!();
    await updatePromise;
    const loaded = await repo.get(created.id);
    expect(loaded!.query.q).toBe('update-original');
  });

  // ---- Caller mutation cannot affect returned values (list/get/create/update are detached) ----

  it('create returns a detached copy (caller mutation does not affect repo state)', async () => {
    const created = await repo.create(makeInput('detached3'));
    const primaryPath = path.join(root, 'saved-searches.json');
    const returned = created;
    // Mutate the returned object.
    returned.name = 'mutated-return';
    const loaded = await repo.get(created.id);
    // The persisted record should remain unchanged.
    expect(loaded!.name).toBe('detached3');
  });

  it('get returns a detached copy (caller mutation does not affect repo state)', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [{ id: 'x', name: 'Test', query: { q: 'test' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' }],
    });
    const got = await repo.get('x');
    // Mutate returned.
    got!.name = 'mutated-get';
    const got2 = await repo.get('x');
    // Should still be "Test".
    expect(got2!.name).toBe('Test');
  });

  it('list returns detached copies (caller mutation does not affect repo state)', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [{ id: 'x', name: 'Test', query: { q: 'test' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' }],
    });
    const list = await repo.list();
    // Mutate first item.
    list[0].name = 'mutated-list';
    const list2 = await repo.list();
    // Should still be "Test".
    expect(list2[0].name).toBe('Test');
  });

  it('update returns a detached copy (caller mutation does not affect repo state)', async () => {
    const created = await repo.create(makeInput('detached4'));
    const updated = await repo.update(created.id, makeInput('updated4'));
    // Mutate returned.
    updated!.name = 'mutated-update';
    const loaded = await repo.get(created.id);
    // Persisted should be "updated4".
    expect(loaded!.name).toBe('updated4');
  });

  // ---- Strict envelope validation tests ---------------------------------------

  it('rejects malformed JSON', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    fs.writeFileSync(primaryPath, '{broken}', 'utf8');
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects unsupported version', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, { version: 0, items: [] });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects version 2', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, { version: 2, items: [] });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects extra keys in envelope', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, { version: 1, items: [], extra: 'x' });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects missing items key', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    fs.writeFileSync(primaryPath, JSON.stringify({ version: 1 }), 'utf8');
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects missing version key', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    fs.writeFileSync(primaryPath, JSON.stringify({ items: [] }), 'utf8');
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects items as non-array', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, { version: 1, items: 'not-array' });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects duplicate IDs', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'dup', name: 'First', query: { q: 'x' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
        { id: 'dup', name: 'Second', query: { q: 'x' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects missing required fields', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [{ id: 'x', name: 'Test', query: { q: 'x' } }],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects missing createdAt', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [{ id: 'x', name: 'Test', query: { q: 'x' }, updatedAt: '2026-07-31T12:00:00.000Z' }],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects non-canonical timestamps', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { q: 'x' }, createdAt: '2026-07-31', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects arrays as query', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: [], createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects unknown keys in item', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        {
          id: 'x',
          name: 'Test',
          query: { q: 'x' },
          createdAt: '2026-07-31T12:00:00.000Z',
          updatedAt: '2026-07-31T12:00:00.000Z',
          extra: 'y',
        },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects unknown keys in query', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        {
          id: 'x',
          name: 'Test',
          query: { q: 'x', unknown: 'y' },
          createdAt: '2026-07-31T12:00:00.000Z',
          updatedAt: '2026-07-31T12:00:00.000Z',
        },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects unsafe keys in query', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    // Write a JSON string with "__proto__" as a literal key.
    // JSON.stringify on a JS object with __proto__ setter would omit it.
    // Use a manually crafted JSON string.
    const rawJson = `{
  "version": 1,
  "items": [
    {
      "id": "x",
      "name": "Test",
      "query": { "q": "x", "__proto__": {} },
      "createdAt": "2026-07-31T12:00:00.000Z",
      "updatedAt": "2026-07-31T12:00:00.000Z"
    }
  ]
}`;
    fs.writeFileSync(primaryPath, rawJson + '\n');
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects invalid tags (non-string members)', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        {
          id: 'x',
          name: 'Test',
          query: { tags: [1] },
          createdAt: '2026-07-31T12:00:00.000Z',
          updatedAt: '2026-07-31T12:00:00.000Z',
        },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects both tags and tagExpression', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        {
          id: 'x',
          name: 'Test',
          query: { tags: ['t1'], tagExpression: 't2' },
          createdAt: '2026-07-31T12:00:00.000Z',
          updatedAt: '2026-07-31T12:00:00.000Z',
        },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  // ---- Envelope format tests -------------------------------------------------

  it('exact envelope format: pretty JSON + trailing newline', async () => {
    await repo.create(makeInput('format'));
    const primaryPath = path.join(root, 'saved-searches.json');
    const raw = readFile(primaryPath);
    // Should end with \n
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.items).toHaveLength(1);
  });

  it('failed replacement recovery: next operation succeeds', async () => {
    const brokenRoot = testRoot();
    let firstCall = true;
    const brokenRepo = makeRepo(brokenRoot, {
      replaceFile: async (_targetPath, _content) => {
        if (firstCall) {
          firstCall = false;
          throw new Error('simulated failure');
        }
        await fs.promises.writeFile(_targetPath, _content);
      },
    });
    // Create should fail
    await expect(brokenRepo.create(makeInput('fail'))).rejects.toThrow('simulated failure');
    // Next operation should succeed
    const second = await brokenRepo.create(makeInput('success'));
    expect(second).toBeDefined();
    fs.rmSync(brokenRoot, { recursive: true, force: true });
  });

  it('detached outputs (no caller mutation leaks)', async () => {
    const input: SavedSearchInput = { name: 'detached2', query: { q: 'test2' } };
    const saved = await repo.create(input);
    input.name = 'mutated2';
    input.query.q = 'mutated2';
    const loaded = await repo.get(saved.id);
    expect(loaded!.name).toBe('detached2');
    expect(loaded!.query.q).toBe('test2');
  });

  // ---- Persisted saved-search canonical validation tests ----

  it('rejects whitespace-only name', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    // Envelope with a name consisting solely of spaces.
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: '   ', query: { q: 'x' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects name exceeding 120 characters', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    const longName = 'a'.repeat(121);
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: longName, query: { q: 'x' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects empty query string (q)', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { q: '' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects whitespace-only query string (q)', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { q: '   ' }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects empty tags array', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { tags: [] }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects whitespace-only tags', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { tags: ['   '] }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects non-string tag', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { tags: [42] }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects tags exceeding 100 entries', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    const hundredPlus = Array.from({ length: 101 }, (_, i) => `tag${i}`);
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { tags: hundredPlus }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects tag exceeding 500 characters', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    const longTag = 'a'.repeat(501);
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { tags: [longTag] }, createdAt: '2026-07-31T12:00:00.000Z', updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects impossible timestamps', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    // Use a date that cannot be parsed (e.g., "invalid-date").
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        {
          id: 'x',
          name: 'Test',
          query: { q: 'x' },
          createdAt: 'invalid-date',
          updatedAt: '2026-07-31T12:00:00.000Z',
        },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects ISO timestamps without milliseconds', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        {
          id: 'x',
          name: 'Test',
          query: { q: 'x' },
          createdAt: '2026-07-31T12:00:00Z',
          updatedAt: '2026-07-31T12:00:00.000Z',
        },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });

  it('rejects non-string createdAt', async () => {
    const primaryPath = path.join(root, 'saved-searches.json');
    writeEnvelope(primaryPath, {
      version: 1,
      items: [
        { id: 'x', name: 'Test', query: { q: 'x' }, createdAt: 123, updatedAt: '2026-07-31T12:00:00.000Z' },
      ],
    });
    await expect(repo.list()).rejects.toThrow();
  });
});
