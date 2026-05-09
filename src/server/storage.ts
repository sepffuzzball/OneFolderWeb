import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, LibrarySettings, MediaItem } from '../shared/types.js';
import { paths } from './config.js';

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
  };
  return { libraries: [library], tagCatalog: [] };
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
    })),
    tagCatalog: Array.from(new Set((settings.tagCatalog ?? []).map(String).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    ),
  };
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized: AppSettings = {
    libraries: settings.libraries.map((library, index) => ({
      id: library.id || randomUUID(),
      name: library.name || `Library ${index + 1}`,
      path: path.resolve(library.path),
      enabled: library.enabled !== false,
    })),
    tagCatalog: Array.from(new Set((settings.tagCatalog ?? []).map(String).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b),
    ),
  };
  await writeJson(settingsPath, normalized);
  await backupJson('settings', normalized);
  return normalized;
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
  await fs.promises.mkdir(paths.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.promises.writeFile(path.join(paths.backupDir, `${prefix}-${stamp}.json`), `${JSON.stringify(value, null, 2)}\n`);
}
