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
import type { AppSettings, MediaItem } from '../../shared/types.js';
import type { MediaIndex, SettingsRepository, MediaIndexRepository } from './repositories.js';

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

function normalizeTagAliases(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const aliases: Record<string, string[]> = {};
  for (const [tag, rawAliases] of Object.entries(value)) {
    if (!Array.isArray(rawAliases)) continue;
    const cleanTag = String(tag).trim();
    const cleanAliases = Array.from(
      new Set(
        rawAliases
          .map(String)
          .map((alias) => alias.trim())
          .filter(Boolean),
      ),
    ).sort((a, b) => a.localeCompare(b));
    if (cleanTag && cleanAliases.length > 0) aliases[cleanTag] = cleanAliases;
  }
  return aliases;
}

function normalizeSettingsForLoad(
  settings: AppSettings,
  defaultLibraryPath: string,
): AppSettings {
  const libraries = settings.libraries;
  // Only called when libraries is a valid nonempty array
  return {
    libraries: libraries.map((library, index) => ({
      id: library.id || `library-${index + 1}`,
      name: library.name || `Library ${index + 1}`,
      path: path.resolve(library.path || defaultLibraryPath),
      enabled: library.enabled !== false,
      startExpanded: library.startExpanded !== false,
    })),
    tagCatalog: Array.from(
      new Set((settings.tagCatalog ?? []).map(String).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b)),
    tagAliases: normalizeTagAliases(settings.tagAliases),
  };
}

function normalizeSettings(settings: AppSettings): AppSettings {
  return {
    libraries: settings.libraries.map((library, index) => ({
      id: library.id || randomUUID(),
      name: library.name || `Library ${index + 1}`,
      path: path.resolve(library.path),
      enabled: library.enabled !== false,
      startExpanded: library.startExpanded !== false,
    })),
    tagCatalog: Array.from(
      new Set((settings.tagCatalog ?? []).map(String).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b)),
    tagAliases: normalizeTagAliases(settings.tagAliases),
  };
}

// ---- Default settings --------------------------------------------------------

function defaultSettings(): AppSettings {
  return {
    libraries: [
      { id: 'default', name: 'Library', path: paths.dataRoot, enabled: true, startExpanded: true },
    ],
    tagCatalog: [],
    tagAliases: {},
  };
}

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
