import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeConfig, ViewMode } from '../shared/types.js';

const rootDir = process.cwd();

function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function boolFromEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function listFromEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((tag) => tag.trim()).filter(Boolean);
  } catch {
    // Comma-separated values are friendlier in Docker Compose.
  }
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function viewModeFromEnv(name: string, fallback: ViewMode): ViewMode {
  const value = process.env[name] as ViewMode | undefined;
  const allowed = new Set<ViewMode>(['list', 'grid', 'masonry-vertical', 'masonry-horizontal', 'calendar']);
  return value && allowed.has(value) ? value : fallback;
}

export const paths = {
  rootDir,
  dataRoot: path.resolve(process.env.DATA_ROOT ?? path.join(rootDir, 'data', 'library')),
  settingsDir: path.resolve(process.env.SETTINGS_DIR ?? path.join(rootDir, 'data', 'settings')),
  thumbnailDir: path.resolve(process.env.THUMBNAIL_DIR ?? path.join(rootDir, 'data', 'thumbnails')),
  backupDir: path.resolve(process.env.BACKUP_DIR ?? path.join(rootDir, 'data', 'backups')),
  trashDir: path.resolve(process.env.TRASH_DIR ?? path.join(rootDir, 'data', 'trash')),
  publicDir: path.resolve(rootDir, 'dist', 'public'),
};

export const runtimeConfig: RuntimeConfig = {
  version: packageVersion(),
  siteName: process.env.SITE_NAME?.trim() || 'OneFolder Web',
  readOnly: boolFromEnv('READ_ONLY', false),
  blacklistedTags: listFromEnv('BLACKLISTED_TAGS'),
  hideEmptyFolders: boolFromEnv('HIDE_EMPTY_FOLDERS', false),
  maxUploadMb: numberFromEnv('MAX_UPLOAD_MB', 250),
  defaultReadOnlyView: viewModeFromEnv('DEFAULT_READ_ONLY_VIEW', 'grid'),
  backupIntervalHours: numberFromEnv('BACKUP_INTERVAL_HOURS', 24),
  backupRetentionDays: numberFromEnv('BACKUP_RETENTION_DAYS', 90),
};

export const serverConfig = {
  host: process.env.HOST?.trim() || '0.0.0.0',
  port: numberFromEnv('PORT', 4317),
  scanIntervalMs: numberFromEnv('SCAN_INTERVAL_MS', 15_000),
};

export async function ensureStorageDirs(): Promise<void> {
  await Promise.all(
    Object.values(paths)
      .filter((dir) => dir !== paths.publicDir)
      .map((dir) => fs.promises.mkdir(dir, { recursive: true })),
  );
}
