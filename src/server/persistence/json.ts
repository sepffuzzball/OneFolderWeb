/**
 * JSON-file-based implementations of SettingsRepository and MediaIndexRepository.
 *
 * Implements a shared keyed serial executor to serialize all operations on the
 * same primary path (including load operations), atomic file replacement via
 * temp+rename, backup deduplication and pruning, and a detached-input snapshot
 * pattern to prevent caller mutations from leaking into queued work.
 *
 * Limitation: Atomic replacement is not fsync-durable nor cross-process
 * coordinated; it is replacement safety, not durability.
 *
 * The queue serializes all same-process repository operations, not just writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import { paths, runtimeConfig } from '../config.js';
import type { AppSettings, MediaItem, SavedSearch } from '../../shared/types.js';
import type { SavedSearchInput, SavedSearchRepository, MediaIndex, SettingsRepository, MediaIndexRepository } from './repositories.js';
import { ValidationError } from '../validation.js';

// ---- Keyed serial executor -------------------------------------------------

type KeyedExecutorKey = string;

/** Per-key queue of pending operations, FIFO. */
const queues = new Map<
  KeyedExecutorKey,
  { current: Promise<unknown> | undefined; tail: QueueTail<unknown>[] }
>();

type QueueTail<T> = {
  resolve: (value: T) => void;
  reject: (e: Error) => void;
  work: () => Promise<T>;
};

function acquire<T>(key: KeyedExecutorKey): {
  enqueue: (work: () => Promise<T>) => Promise<T>;
  dequeue: () => void;
} {
  let entry = queues.get(key) as
    | { current: Promise<unknown> | undefined; tail: QueueTail<T>[] }
    | undefined;
  if (!entry) {
    entry = { current: undefined, tail: [] as QueueTail<T>[] };
    queues.set(key, entry as { current: Promise<unknown> | undefined; tail: QueueTail<unknown>[] });
  }

  async function enqueue(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      (entry!.tail as QueueTail<T>[]).push({ resolve, reject, work });

      function drain() {
        const next = (entry!.tail as QueueTail<T>[]).shift();
        if (!next) {
          // If the queue is now empty, remove the key so later operations start fresh.
          if (entry!.tail.length === 0) queues.delete(key);
          return;
        }
        entry!.current = (async () => {
          try {
            const result = await next.work();
            next.resolve(result);
          } catch (e) {
            next.reject(e as Error);
          } finally {
            drain();
          }
        })();
      }

      if (!entry!.current) {
        drain();
      }
    });
  }

  function dequeue(): void {
    // No-op; used internally to remove the key tail when the queue becomes empty.
    // The drain() function already handles removal.
  }

  return { enqueue, dequeue };
}

// ---- Atomic file replacement ------------------------------------------------

/**
 * Options for atomicReplace: injected low-level write/rename/remove operations.
 */
export interface AtomicReplaceOptions {
  writeFile: (path: string, content: string) => Promise<void>;
  renameFile: (from: string, to: string) => Promise<void>;
  removeFile: (path: string) => Promise<void>;
}

/**
 * The default implementations for AtomicReplaceOptions, using fs.promises.
 */
export const defaultAtomicReplaceOptions: AtomicReplaceOptions = {
  async writeFile(path, content) {
    await fs.promises.writeFile(path, content);
  },
  async renameFile(from, to) {
    await fs.promises.rename(from, to);
  },
  async removeFile(path) {
    await fs.promises.rm(path, { force: true }).catch(() => undefined);
  },
};

/**
 * Atomically replace a file at `targetPath` with new content. Creates a temp
 * file in the same directory named `<targetPath>.<pid>.<randomUUID>.tmp`,
 * writes the serialized content, then renames directly over `targetPath` without
 * deleting the target (preserving prior file). Finally removes leftover temp.
 *
 * This provides replacement safety, not fsync durability or cross-process coordination.
 */
export async function atomicReplace(
  targetPath: string,
  content: string,
  opts?: AtomicReplaceOptions,
): Promise<void> {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tempPath = path.join(dir, `${base}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.promises.mkdir(dir, { recursive: true });
  const writeFile = opts?.writeFile ?? defaultAtomicReplaceOptions.writeFile;
  const renameFile = opts?.renameFile ?? defaultAtomicReplaceOptions.renameFile;
  const removeFile = opts?.removeFile ?? defaultAtomicReplaceOptions.removeFile;
  try {
    await writeFile(tempPath, content);
    await renameFile(tempPath, targetPath);
  } finally {
    // Clean up leftover temp (if rename succeeded, the temp no longer exists).
    try {
      await removeFile(tempPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

// ---- Backup helpers ---------------------------------------------------------

function stableBackupValue(prefix: string, value: unknown): unknown {
  if (prefix !== 'index' || !value || typeof value !== 'object') return value;
  const index = value as MediaIndex;
  return { version: index.version, files: index.files };
}

function backupPeriodKey(date: Date, intervalHours: number): string {
  if (intervalHours === 24) return date.toISOString().slice(0, 10);
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const start = new Date(Math.floor(date.getTime() / intervalMs) * intervalMs);
  return start.toISOString().replace(/[:.]/g, '-');
}

async function latestBackupHash(prefix: string, backupDir: string): Promise<string | undefined> {
  const backups = await backupFiles(prefix, backupDir);
  const latest = backups.at(-1);
  if (!latest) return undefined;
  const text = await fs.promises.readFile(path.join(backupDir, latest.name), 'utf8').catch(() => undefined);
  return text ? crypto.createHash('sha256').update(text).digest('hex') : undefined;
}

async function backupFiles(prefix: string, backupDir: string): Promise<Array<{ name: string; mtimeMs: number }>> {
  const entries = await fs.promises.readdir(backupDir, { withFileTypes: true }).catch(() => []);
  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const stat = await fs.promises.stat(path.join(backupDir, entry.name));
        return { name: entry.name, mtimeMs: stat.mtimeMs };
      }),
  );
  return backups.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}

async function pruneBackups(prefix: string, retentionDays: number, backupDir: string): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const backups = await backupFiles(prefix, backupDir);
  await Promise.all(
    backups
      .filter((backup) => backup.mtimeMs < cutoff)
      .map((backup) => fs.promises.rm(path.join(backupDir, backup.name), { force: true }).catch(() => undefined)),
  );
}

// ---- Settings normalization -------------------------------------------------
// (Re-exported from settings-normalization.ts for reuse)

import {
  normalizeSettings,
  normalizeSettingsForLoad,
  defaultSettings,
} from './settings-normalization.js';

// ---- JsonSettingsRepository --------------------------------------------------

export class JsonSettingsRepository implements SettingsRepository {
  readonly #primaryPath: string;
  readonly #backupDir: string;
  readonly #retentionDays: number;
  readonly #intervalHours: number;
  readonly #defaultSettings: () => AppSettings;
  readonly #defaultLibraryPath: string;
  readonly #replaceFile: (targetPath: string, content: string) => Promise<void>;
  readonly #key: KeyedExecutorKey;

  constructor(opts: {
    primaryPath: string;
    backupDir: string;
    backupRetentionDays: number;
    backupIntervalHours: number;
    defaultSettings: () => AppSettings;
    defaultLibraryPath?: string;
    replaceFile?: (targetPath: string, content: string) => Promise<void>;
  }) {
    this.#primaryPath = opts.primaryPath;
    this.#backupDir = opts.backupDir;
    this.#retentionDays = opts.backupRetentionDays;
    this.#intervalHours = opts.backupIntervalHours;
    this.#defaultSettings = opts.defaultSettings;
    this.#defaultLibraryPath = opts.defaultLibraryPath ?? paths.dataRoot;
    this.#replaceFile = opts.replaceFile ?? atomicReplace;
    // Key is the canonical primary file path to share queues across instances.
    this.#key = path.resolve(opts.primaryPath);
  }

  async load(): Promise<AppSettings> {
    const { enqueue } = acquire<AppSettings>(this.#key);
    return enqueue(async () => {
      const raw = await readJson<AppSettings>(
        this.#primaryPath,
        this.#defaultSettings(),
      );
      if (!Array.isArray(raw.libraries) || raw.libraries.length === 0) {
        return this.#defaultSettings();
      }
      return normalizeSettingsForLoad(raw, this.#defaultLibraryPath);
    });
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const normalized = normalizeSettings(settings);
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

    const { enqueue } = acquire<AppSettings>(this.#key);
    return enqueue(async () => {
      const now = new Date();
      // Primary write
      await this.#replaceFile(this.#primaryPath, serialized);
      // Backup, pruning, dedupe
      await this.#backup(normalized, 'settings', now);
      return normalized;
    });
  }

  async update(
    mutator: (current: Readonly<AppSettings>) => AppSettings,
  ): Promise<AppSettings> {
    const { enqueue } = acquire<AppSettings>(this.#key);

    return enqueue(async () => {
      // Internal unlocked read to avoid reentrant deadlock.
      let raw = await readJson<AppSettings>(
        this.#primaryPath,
        this.#defaultSettings(),
      );
      if (!Array.isArray(raw.libraries) || raw.libraries.length === 0) {
        raw = this.#defaultSettings();
      }
      const current = normalizeSettingsForLoad(raw, this.#defaultLibraryPath);
      // The mutator receives a detached readonly snapshot.
      const mutated = mutator(
        Object.freeze(current) as Readonly<AppSettings>,
      );
      const normalized = normalizeSettings(mutated);
      const serialized = `${JSON.stringify(normalized, null, 2)}\n`;

      const now = new Date();
      await this.#replaceFile(this.#primaryPath, serialized);
      await this.#backup(normalized, 'settings', now);
      return normalized;
    });
  }

  async #backup(
    normalized: AppSettings,
    prefix: string,
    now: Date,
  ): Promise<void> {
    if (this.#retentionDays <= 0 || this.#intervalHours <= 0) return;

    await fs.promises.mkdir(this.#backupDir, { recursive: true });
    await pruneBackups(prefix, this.#retentionDays, this.#backupDir);

    const stableValue = stableBackupValue(prefix, normalized);
    const backupSerialized = `${JSON.stringify(stableValue, null, 2)}\n`;
    const hash = crypto.createHash('sha256').update(backupSerialized).digest('hex');
    const latestHash = await latestBackupHash(prefix, this.#backupDir);
    if (latestHash === hash) return;

    const period = backupPeriodKey(now, this.#intervalHours);
    const backupPath = path.join(
      this.#backupDir,
      `${prefix}-${period}.json`,
    );
    await this.#replaceFile(backupPath, backupSerialized);
  }
}

// ---- -----------------------------------------------

export class JsonMediaIndexRepository implements MediaIndexRepository {
  readonly #primaryPath: string;
  readonly #backupDir: string;
  readonly #retentionDays: number;
  readonly #intervalHours: number;
  readonly #defaultIndex: () => MediaIndex;
  readonly #replaceFile: (targetPath: string, content: string) => Promise<void>;
  readonly #key: KeyedExecutorKey;

  constructor(opts: {
    primaryPath: string;
    backupDir: string;
    backupRetentionDays: number;
    backupIntervalHours: number;
    defaultIndex: () => MediaIndex;
    replaceFile?: (targetPath: string, content: string) => Promise<void>;
  }) {
    this.#primaryPath = opts.primaryPath;
    this.#backupDir = opts.backupDir;
    this.#retentionDays = opts.backupRetentionDays;
    this.#intervalHours = opts.backupIntervalHours;
    this.#defaultIndex = opts.defaultIndex;
    this.#replaceFile = opts.replaceFile ?? atomicReplace;
    this.#key = path.resolve(opts.primaryPath);
  }

  async load(): Promise<MediaIndex> {
    const { enqueue } = acquire<MediaIndex>(this.#key);
    return enqueue(async () => {
      return readJson<MediaIndex>(this.#primaryPath, this.#defaultIndex());
    });
  }

  async save(files: readonly MediaItem[]): Promise<MediaIndex> {
    const snapshot = structuredClone(files) as MediaItem[];
    const index: MediaIndex = {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: snapshot,
    };
    const serialized = `${JSON.stringify(index, null, 2)}\n`;

    const { enqueue } = acquire<MediaIndex>(this.#key);
    return enqueue(async () => {
      await this.#replaceFile(this.#primaryPath, serialized);
      await this.#backup(index, 'index', new Date());
      return index;
    });
  }

  async #backup(
    index: MediaIndex,
    prefix: string,
    now: Date,
  ): Promise<void> {
    if (this.#retentionDays <= 0 || this.#intervalHours <= 0) return;

    await fs.promises.mkdir(this.#backupDir, { recursive: true });
    await pruneBackups(prefix, this.#retentionDays, this.#backupDir);

    // Stable backup: omit generatedAt for index
    const stableValue = stableBackupValue(prefix, index);
    const backupSerialized = `${JSON.stringify(stableValue, null, 2)}\n`;
    const hash = crypto.createHash('sha256').update(backupSerialized).digest('hex');
    const latestHash = await latestBackupHash(prefix, this.#backupDir);
    if (latestHash === hash) return;

    const period = backupPeriodKey(now, this.#intervalHours);
    const backupPath = path.join(
      this.#backupDir,
      `${prefix}-${period}.json`,
    );
    await this.#replaceFile(backupPath, backupSerialized);
  }
}

// ---- JsonSavedSearchRepository ---------------------------------------------

/**
 * Exact on-disk envelope shape for saved searches.
 */
export type SavedSearchEnvelope = {
  version: number;
  items: SavedSearch[];
};

/**
 * JSON-file-based implementation of SavedSearchRepository.
 *
 * Uses the same shared-keyed-executor pattern as the other JSON repositories.
 * All CRUD methods use the same canonical-path queue and perform one locked
 * read-modify-write. Inputs and outputs must be detached snapshots.
 */
export class JsonSavedSearchRepository implements SavedSearchRepository {
  readonly #primaryPath: string;
  readonly #replaceFile: (targetPath: string, content: string) => Promise<void>;
  readonly #clock: () => string;
  readonly #idGenerator: () => string;
  readonly #key: KeyedExecutorKey;

  constructor(opts: {
    primaryPath: string;
    replaceFile?: (targetPath: string, content: string) => Promise<void>;
    clock?: () => string;
    idGenerator?: () => string;
  }) {
    this.#primaryPath = opts.primaryPath;
    this.#replaceFile = opts.replaceFile ?? atomicReplace;
    this.#clock = opts.clock ?? (() => new Date().toISOString());
    this.#idGenerator = opts.idGenerator ?? randomUUID;
    this.#key = path.resolve(opts.primaryPath);
  }

  /** Deep-clone helper to ensure detached snapshots. */
  #deepClone<T>(value: T): T {
    return structuredClone(value);
  }

  async list(): Promise<SavedSearch[]> {
    const { enqueue } = acquire<SavedSearch[]>(this.#key);
    return enqueue(async () => {
      const envelope = await readEnvelope(this.#primaryPath);
      // Deterministic order: name localeCompare then id
      const sorted = envelope.items.sort((a, b) =>
        a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      );
      // Return deep-detached copies.
      return sorted.map((item) => this.#deepClone(item));
    });
  }

  async get(id: string): Promise<SavedSearch | undefined> {
    const { enqueue } = acquire<SavedSearch | undefined>(this.#key);
    return enqueue(async () => {
      const envelope = await readEnvelope(this.#primaryPath);
      const found = envelope.items.find((item) => item.id === id);
      // Return deep-detached copy if found, else undefined.
      return found ? this.#deepClone(found) : undefined;
    });
  }

  async create(input: SavedSearchInput): Promise<SavedSearch> {
    // Deep-clone the input before enqueueing to prevent caller mutation leaks.
    const clampedInput = this.#deepClone(input);
    const { enqueue } = acquire<SavedSearch>(this.#key);
    return enqueue(async () => {
      const envelope = await readEnvelope(this.#primaryPath);
      const id = this.#idGenerator();
      const now = this.#clock();
      const savedSearch: SavedSearch = {
        id,
        createdAt: now,
        updatedAt: now,
        name: clampedInput.name,
        query: clampedInput.query,
      };
      envelope.items.push(savedSearch);
      await writeEnvelope(this.#primaryPath, envelope, this.#replaceFile);
      return this.#deepClone(savedSearch);
    });
  }

  async update(id: string, input: SavedSearchInput): Promise<SavedSearch | undefined> {
    // Deep-clone the input before enqueueing.
    const clampedInput = this.#deepClone(input);
    const { enqueue } = acquire<SavedSearch | undefined>(this.#key);
    return enqueue(async () => {
      const envelope = await readEnvelope(this.#primaryPath);
      const index = envelope.items.findIndex((item) => item.id === id);
      if (index === -1) return undefined;
      const existing = envelope.items[index];
      const now = this.#clock();
      const updated: SavedSearch = {
        ...this.#deepClone(existing),
        name: clampedInput.name,
        query: clampedInput.query,
        updatedAt: now,
        // id and createdAt are preserved
      };
      envelope.items[index] = updated;
      await writeEnvelope(this.#primaryPath, envelope, this.#replaceFile);
      return this.#deepClone(updated);
    });
  }

  async delete(id: string): Promise<boolean> {
    const { enqueue } = acquire<boolean>(this.#key);
    return enqueue(async () => {
      const envelope = await readEnvelope(this.#primaryPath);
      const index = envelope.items.findIndex((item) => item.id === id);
      if (index === -1) return false;
      envelope.items.splice(index, 1);
      await writeEnvelope(this.#primaryPath, envelope, this.#replaceFile);
      return true;
    });
  }
}

// ---- Production singleton wiring --------------------------------------------

/**
 * Production singleton wired to current paths and runtimeConfig.
 * Tests may create separate instances with explicit options.
 */
export const settingsRepository: SettingsRepository = new JsonSettingsRepository({
  primaryPath: path.join(paths.settingsDir, 'settings.json'),
  backupDir: paths.backupDir,
  backupRetentionDays: runtimeConfig.backupRetentionDays,
  backupIntervalHours: runtimeConfig.backupIntervalHours,
  defaultSettings,
});

export const mediaIndexRepository: MediaIndexRepository =
  new JsonMediaIndexRepository({
    primaryPath: path.join(paths.settingsDir, 'index.json'),
    backupDir: paths.backupDir,
    backupRetentionDays: runtimeConfig.backupRetentionDays,
    backupIntervalHours: runtimeConfig.backupIntervalHours,
    defaultIndex: () => ({
      version: 1,
      generatedAt: new Date(0).toISOString(),
      files: [],
    }),
  });

export const savedSearchesRepository: JsonSavedSearchRepository =
  new JsonSavedSearchRepository({
    primaryPath: path.join(paths.settingsDir, 'saved-searches.json'),
  });

// ---- Generic JSON read helper -----------------------------------------------

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * Read the saved-search envelope from disk.
 * Missing file returns empty envelope with version 1.
 * Malformed JSON, unsupported version, or invalid structure must reject.
 */
async function readEnvelope(filePath: string): Promise<SavedSearchEnvelope> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as SavedSearchEnvelope;

    // Enforce plain object (no arrays, nulls, or non-objects).
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Malformed saved-search envelope: not a plain object');
    }

    // Enforce exactly keys "version" and "items".
    const parsedKeys = new Set(Object.keys(parsed));
    if (parsedKeys.size !== 2 || !parsedKeys.has('version') || !parsedKeys.has('items')) {
      throw new Error('Malformed saved-search envelope: unknown keys or missing required keys');
    }

    // Enforce version exactly 1.
    if (typeof parsed.version !== 'number' || parsed.version !== 1) {
      throw new Error(`Unsupported saved-search envelope version: ${parsed.version}`);
    }

    // Enforce items is an array.
    if (!Array.isArray(parsed.items)) {
      throw new Error('Malformed saved-search envelope: items must be an array');
    }

    // Validate each item.
    for (const item of parsed.items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error('Malformed saved-search item: not a plain object');
      }

      // Item must have exactly keys: id, name, query, createdAt, updatedAt (no extras).
      const itemKeys = new Set(Object.keys(item));
      if (itemKeys.size !== 5 ||
          !itemKeys.has('id') || !itemKeys.has('name') ||
          !itemKeys.has('query') || !itemKeys.has('createdAt') ||
          !itemKeys.has('updatedAt')) {
        throw new Error('Malformed saved-search item: missing required keys or extra keys');
      }

      // id must be a non-empty trimmed string.
      if (typeof item.id !== 'string' || item.id.trim() === '' || item.id !== item.id.trim()) {
        throw new Error('Malformed saved-search item: id must be a non-empty trimmed string');
      }

      // name must be a non-empty trimmed string, at most 120 characters.
      if (typeof item.name !== 'string' || item.name.trim() === '' || item.name !== item.name.trim() || item.name.length > 120) {
        throw new Error('Malformed saved-search item: name must be a non-empty trimmed string at most 120 characters');
      }

      // createdAt and updatedAt must be valid canonical ISO timestamps with milliseconds.
      if (typeof item.createdAt !== 'string') {
        throw new Error('Malformed saved-search item: createdAt must be a string');
      }
      const createdAt = new Date(item.createdAt);
      if (isNaN(createdAt.getTime()) || createdAt.toISOString() !== item.createdAt) {
        throw new Error('Malformed saved-search item: createdAt must be a valid canonical ISO timestamp');
      }
      if (typeof item.updatedAt !== 'string') {
        throw new Error('Malformed saved-search item: updatedAt must be a string');
      }
      const updatedAt = new Date(item.updatedAt);
      if (isNaN(updatedAt.getTime()) || updatedAt.toISOString() !== item.updatedAt) {
        throw new Error('Malformed saved-search item: updatedAt must be a valid canonical ISO timestamp');
      }

      // query must be a plain object with only allowed keys.
      if (typeof item.query !== 'object' || item.query === null || Array.isArray(item.query)) {
        throw new Error('Malformed saved-search item: query must be a plain object');
      }
      // Reject prototype pollution: ensure prototype is Object.prototype or null.
      const proto = Object.getPrototypeOf(item.query);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error('Malformed saved-search item: query prototype is unsafe');
      }

      const allowedQueryKeys = new Set(['q', 'tags', 'tagExpression', 'folder', 'libraryId']);
      const queryKeys = Object.keys(item.query);
      for (const key of queryKeys) {
        if (!allowedQueryKeys.has(key)) {
          throw new Error(`Malformed saved-search item: unknown query key "${key}"`);
        }
      }
      // Reject unsafe keys at the query level (including __proto__ which may appear
      // as a regular key when it was serialized as a JSON literal).
      const unsafe = ['__proto__', 'prototype', 'constructor'];
      for (const key of queryKeys) {
        if (unsafe.includes(key)) {
          throw new Error(`Malformed saved-search item: unsafe query key "${key}"`);
        }
      }

      // Query values: q, folder, libraryId, tagExpression must be a nonempty already-trimmed string;
      // tags must be an array of 1..100 already-trimmed nonempty strings of at most 500 characters.
      // Also, reject any value whose canonical normalized form differs (i.e., silently normalizing is
      // forbidden; the persisted value must match exactly the form that would be produced by the
      // normalization helpers).
      if (item.query.q !== undefined) {
        if (typeof item.query.q !== 'string') {
          throw new Error('Malformed saved-search item: query.q must be a string');
        }
        const trimmedQ = item.query.q.trim();
        if (trimmedQ === '' || trimmedQ !== item.query.q || trimmedQ.length > 1000) {
          throw new Error('Malformed saved-search item: query.q must be a nonempty trimmed string at most 1000 characters');
        }
      }
      if (item.query.folder !== undefined) {
        if (typeof item.query.folder !== 'string') {
          throw new Error('Malformed saved-search item: query.folder must be a string');
        }
        const trimmedFolder = item.query.folder.trim();
        if (trimmedFolder === '' || trimmedFolder !== item.query.folder || trimmedFolder.length > 1000) {
          throw new Error('Malformed saved-search item: query.folder must be a nonempty trimmed string at most 1000 characters');
        }
      }
      if (item.query.libraryId !== undefined) {
        if (typeof item.query.libraryId !== 'string') {
          throw new Error('Malformed saved-search item: query.libraryId must be a string');
        }
        const trimmedLibId = item.query.libraryId.trim();
        if (trimmedLibId === '' || trimmedLibId !== item.query.libraryId || trimmedLibId.length > 1000) {
          throw new Error('Malformed saved-search item: query.libraryId must be a nonempty trimmed string at most 1000 characters');
        }
      }
      if (item.query.tagExpression !== undefined) {
        if (typeof item.query.tagExpression !== 'string') {
          throw new Error('Malformed saved-search item: query.tagExpression must be a string');
        }
        const trimmedTagExpr = item.query.tagExpression.trim();
        if (trimmedTagExpr === '' || trimmedTagExpr !== item.query.tagExpression || trimmedTagExpr.length > 4000) {
          throw new Error('Malformed saved-search item: query.tagExpression must be a nonempty trimmed string at most 4000 characters');
        }
      }
      if (item.query.tags !== undefined) {
        if (!Array.isArray(item.query.tags)) {
          throw new Error('Malformed saved-search item: query.tags must be an array');
        }
        if (item.query.tags.length < 1 || item.query.tags.length > 100) {
          throw new Error('Malformed saved-search item: query.tags must have 1..100 entries');
        }
        for (const tag of item.query.tags) {
          if (typeof tag !== 'string') {
            throw new Error('Malformed saved-search item: query.tags items must be strings');
          }
          const trimmedTag = tag.trim();
          if (trimmedTag === '' || trimmedTag !== tag || trimmedTag.length > 500) {
            throw new Error('Malformed saved-search item: query.tags item must be a nonempty trimmed string at most 500 characters');
          }
        }
      }
      // Reject both nonempty tags and nonempty tagExpression.
      if (item.query.tags && item.query.tags.length > 0 && item.query.tagExpression) {
        throw new Error('Malformed saved-search item: cannot provide both tags and tagExpression');
      }
      // Validate max lengths (already done in per-value checks above).
    }

    // Reject duplicate IDs.
    const idSet = new Set<string>();
    for (const item of parsed.items) {
      if (idSet.has(item.id)) {
        throw new Error('Duplicate saved-search ID: ' + item.id);
      }
      idSet.add(item.id);
    }

    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Missing file returns empty envelope with version 1
      return { version: 1, items: [] };
    }
    throw error;
  }
}

/**
 * Write the saved-search envelope to disk in pretty JSON with trailing newline.
 */
async function writeEnvelope(
  targetPath: string,
  envelope: SavedSearchEnvelope,
  replaceFile: (targetPath: string, content: string) => Promise<void>,
): Promise<void> {
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  await replaceFile(targetPath, serialized);
}
