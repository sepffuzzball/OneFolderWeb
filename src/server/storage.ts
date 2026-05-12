import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import type { AppSettings, LibrarySettings, MediaItem } from '../shared/types.js';
import { paths, runtimeConfig } from './config.js';

const settingsPath = path.join(paths.settingsDir, 'settings.json');
const indexPath = path.join(paths.settingsDir, 'index.json');

export type MediaIndex = {
  version: number;
  generatedAt: string;
  files: MediaItem[];
};

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(text) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.promises.rm(filePath, { force: true });
  await fs.promises.rename(tempPath, filePath);
}

function defaultSettings(): AppSettings {
  const library: LibrarySettings = {
    id: 'default',
    name: 'Library',
    path: paths.dataRoot,
    enabled: true,
    startExpanded: true,
  };
  return { libraries: [library], tagCatalog: [], tagAliases: {} };
}

export async function loadSettings(): Promise<AppSettings> {
  const settings = await readJson<AppSettings>(settingsPath, defaultSettings());
  if (!Array.isArray(settings.libraries) || settings.libraries.length === 0) {
    return defaultSettings();
  }
  return {
    libraries: settings.libraries.map((library, index) => ({
      id: library.id || `library-${index + 1}`,
      name: library.name || `Library ${index + 1}`,
      path: path.resolve(library.path || paths.dataRoot),
      enabled: library.enabled !== false,
      startExpanded: library.startExpanded !== false,
    })),
    tagCatalog: Array.from(new Set((settings.tagCatalog ?? []).map(String).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    ),
    tagAliases: normalizeTagAliases(settings.tagAliases),
  };
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized: AppSettings = {
    libraries: settings.libraries.map((library, index) => ({
      id: library.id || randomUUID(),
      name: library.name || `Library ${index + 1}`,
      path: path.resolve(library.path),
      enabled: library.enabled !== false,
      startExpanded: library.startExpanded !== false,
    })),
    tagCatalog: Array.from(new Set((settings.tagCatalog ?? []).map(String).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    ),
    tagAliases: normalizeTagAliases(settings.tagAliases),
  };
  await writeJson(settingsPath, normalized);
  await backupJson('settings', normalized);
  return normalized;
}

function normalizeTagAliases(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const aliases: Record<string, string[]> = {};
  for (const [tag, rawAliases] of Object.entries(value)) {
    if (!Array.isArray(rawAliases)) continue;
    const cleanTag = String(tag).trim();
    const cleanAliases = Array.from(new Set(rawAliases.map(String).map((alias) => alias.trim()).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    );
    if (cleanTag && cleanAliases.length > 0) aliases[cleanTag] = cleanAliases;
  }
  return aliases;
}

export async function loadIndex(): Promise<MediaIndex> {
  return readJson<MediaIndex>(indexPath, { version: 1, generatedAt: new Date(0).toISOString(), files: [] });
}

export async function saveIndex(files: MediaItem[]): Promise<MediaIndex> {
  const index: MediaIndex = { version: 1, generatedAt: new Date().toISOString(), files };
  await writeJson(indexPath, index);
  await backupJson('index', index);
  return index;
}

async function backupJson(prefix: string, value: unknown): Promise<void> {
  const retentionDays = runtimeConfig.backupRetentionDays;
  const intervalHours = runtimeConfig.backupIntervalHours;
  if (retentionDays <= 0 || intervalHours <= 0) return;

  await fs.promises.mkdir(paths.backupDir, { recursive: true });
  await pruneBackups(prefix, retentionDays);

  const serialized = `${JSON.stringify(stableBackupValue(prefix, value), null, 2)}\n`;
  const hash = crypto.createHash('sha256').update(serialized).digest('hex');
  const latestHash = await latestBackupHash(prefix);
  if (latestHash === hash) return;

  const period = backupPeriodKey(new Date(), intervalHours);
  const backupPath = path.join(paths.backupDir, `${prefix}-${period}.json`);
  await fs.promises.writeFile(backupPath, serialized);
}

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

async function latestBackupHash(prefix: string): Promise<string | undefined> {
  const backups = await backupFiles(prefix);
  const latest = backups.at(-1);
  if (!latest) return undefined;
  const text = await fs.promises.readFile(path.join(paths.backupDir, latest.name), 'utf8').catch(() => undefined);
  return text ? crypto.createHash('sha256').update(text).digest('hex') : undefined;
}

async function pruneBackups(prefix: string, retentionDays: number): Promise<void> {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const backups = await backupFiles(prefix);
  await Promise.all(
    backups
      .filter((backup) => backup.mtimeMs < cutoff)
      .map((backup) => fs.promises.rm(path.join(paths.backupDir, backup.name), { force: true }).catch(() => undefined)),
  );
}

async function backupFiles(prefix: string): Promise<Array<{ name: string; mtimeMs: number }>> {
  const entries = await fs.promises.readdir(paths.backupDir, { withFileTypes: true }).catch(() => []);
  const backups = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.json'))
      .map(async (entry) => {
        const stat = await fs.promises.stat(path.join(paths.backupDir, entry.name));
        return { name: entry.name, mtimeMs: stat.mtimeMs };
      }),
  );
  return backups.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
}
