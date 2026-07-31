/**
 * Settings normalization helpers extracted from json.ts for reuse in
 * Postgres implementations. These functions normalize AppSettings objects
 * to ensure consistent format across persistence layers.
 */

import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import type { AppSettings, LibrarySettings } from '../../shared/types.js';
import { paths } from '../config.js';

/**
 * Normalize tag aliases: ensure they are a record of string arrays,
 * trimmed, sorted, and non-empty.
 */
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

/**
 * Normalize a settings object for load: apply defaults, resolve paths,
 * and ensure all fields have proper values.
 */
export function normalizeSettingsForLoad(
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

/**
 * Normalize a settings object for save: generate IDs/names if missing,
 * resolve paths, and ensure consistent format.
 */
export function normalizeSettings(settings: AppSettings): AppSettings {
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

/**
 * Default settings for a new empty library.
 */
export function defaultSettings(): AppSettings {
  return {
    libraries: [
      { id: 'default', name: 'Library', path: paths.dataRoot, enabled: true, startExpanded: true },
    ],
    tagCatalog: [],
    tagAliases: {},
  };
}
