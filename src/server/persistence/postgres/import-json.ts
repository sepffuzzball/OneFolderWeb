/**
 * Import JSON-saved repositories into PostgreSQL.
 *
 * Takes immutable deep snapshots of settings, media index, and saved searches
 * from the JSON repositories, validates the MediaIndex envelope shape exactly,
 * computes a semantic SHA-256 digest, and then imports the data into Postgres
 * in a single transaction with an advisory lock and digest check.
 *
 * If the same digest is already recorded (same content), the import is a no-op.
 * If any table in the target DB already has rows (settings, media, saved searches),
 * the import throws a clear error.
 *
 * The import uses parameterized helpers extracted from repositories.ts to share
 * the media staging/23-column logic without duplicating it.
 */

import pg from 'pg';
import crypto from 'node:crypto';
import type {
  AppSettings,
  MediaItem,
  SavedSearch,
} from '../../../shared/types.js';
import type { MediaIndex } from '../repositories.js';
import type { SettingsRepository, MediaIndexRepository, SavedSearchRepository } from '../repositories.js';
import { ValidationError } from '../../validation.js';
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
  createMediaStagingTableSQL,
  encodeMediaItemForStaging,
  replaceMediaInTransaction,
} from './repositories.js';
import { PERSISTENCE_LOCK_KEY } from './repositories.js';

export type ImportResult = {
  status: 'imported' | 'already-imported';
  digest: string;
  counts: {
    settings: number;
    media: number;
    savedSearches: number;
  };
};

/**
 * Recursively canonicalize a plain object: sort keys at every level,
 * preserve array order, and never mutate source arrays.
 */
function canonicalSerialize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalSerialize(item));
  }
  // Plain object: sort keys and recursively serialize values
  const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    result[key] = canonicalSerialize((value as Record<string, unknown>)[key]);
  }
  return result;
}

/**
 * Export a semantic SHA-256 digest over the canonical object labeled
 * `onefolder-json-v1`, including normalized settings, media version + files
 * (but excluding generatedAt), and saved searches sorted by id.
 *
 * All array order is preserved except for saved searches which are sorted
 * deterministically by id for stable digest output.
 *
 * This function never mutates the source arrays/objects.
 */
export function computeDigest(
  settings: AppSettings,
  mediaIndex: MediaIndex,
  savedSearches: SavedSearch[],
): string {
  const hash = crypto.createHash('sha256');

  // Sort saved searches by id before canonicalization (stable order)
  const sortedSearches = [...savedSearches]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => normalizeSavedSearchForDigest(s));

  // Build the canonical object with label
  const canonical: Record<string, unknown> = {
    label: 'onefolder-json-v1',
    settings: canonicalSerialize(normalizeSettingsForDigest(settings)),
    media: {
      version: mediaIndex.version,
      files: canonicalSerialize(
        mediaIndex.files.map((f: MediaItem) => normalizeMediaItemForDigest(f)),
      ),
    },
    savedSearches: sortedSearches,
  };

  hash.update(JSON.stringify(canonical));
  return hash.digest('hex');
}

function normalizeSettingsForDigest(settings: AppSettings): AppSettings {
  // Deep clone and sort keys for stability
  const clone = structuredClone(settings);
  // Do NOT sort tagCatalog or tagAliases arrays - preserve original order
  // Do NOT sort library entries - preserve original order
  return clone;
}

function normalizeMediaItemForDigest(item: MediaItem): MediaItem {
  // Remove generatedAt from the digest computation
  const clone = structuredClone(item);
  // Do NOT sort tags - preserve original order for digest stability
  return clone;
}

function normalizeSavedSearchForDigest(search: SavedSearch): SavedSearch {
  const clone = structuredClone(search);
  // Sort query keys if present
  if (clone.query) {
    const queryKeys = Object.keys(clone.query).sort();
    const sortedQuery: Record<string, unknown> = {};
    for (const key of queryKeys) {
      sortedQuery[key] = clone.query[key as keyof typeof clone.query];
    }
    clone.query = sortedQuery as SavedSearch['query'];
  }
  return clone;
}

/**
 * Import JSON repository data into PostgreSQL.
 *
 * Steps:
 * 1. Load immutable deep snapshots from the JSON repositories.
 * 2. Validate MediaIndex envelope (plain exact shape, version positive integer,
 *    generatedAt canonical ISO, files array; each MediaItem must have correct
 *    required/optional types, valid kind, safe nonnegative integer size,
 *    optional finite dimensions/duration, string tags, unique nonempty ids,
 *    all path/name/time/url/metadata strings).
 * 3. Compute SHA-256 digest.
 * 4. Acquire pool client, BEGIN, pg_advisory_xact_lock, query import_runs by
 *    digest. If same digest committed, release (no-op). Otherwise query counts
 *    for each target table; if any have rows, throw nonempty-target error.
 * 5. Import: app_settings (id=1), media_items + media_index_state, saved_searches.
 * 6. Record import in import_runs.
 * 7. COMMIT / ROLLBACK / release.
 */
export async function importJsonIntoPostgres(
  opts: {
    pool: pg.Pool;
    settingsRepository: SettingsRepository;
    mediaIndexRepository: MediaIndexRepository;
    savedSearchRepository: SavedSearchRepository;
    clock?: () => string;
  },
): Promise<ImportResult> {
  const clock = opts.clock ?? (() => new Date().toISOString());

  // Step 1: Load immutable snapshots
  const settingsSnapshot = await opts.settingsRepository.load();
  const mediaIndexSnapshot = await opts.mediaIndexRepository.load();
  const savedSearchesSnapshot = await opts.savedSearchRepository.list();

  // Step 2: Validate MediaIndex envelope
  validateMediaIndexEnvelope(mediaIndexSnapshot);

  // Step 3: Compute digest
  const digest = computeDigest(settingsSnapshot, mediaIndexSnapshot, savedSearchesSnapshot);

  // Step 4: Acquire client
  const client = await opts.pool.connect();
  try {
    await client.query('BEGIN');

    // Advisory lock for the import transaction
    // Advisory lock for the import transaction (exclusive)
    await client.query('SELECT pg_advisory_xact_lock($1)', [PERSISTENCE_LOCK_KEY]);

    // Check if the same digest is already recorded
    const existingResult = await client.query(
      'SELECT source_digest FROM import_runs WHERE source_digest = $1',
      [digest],
    );

    if (existingResult.rows.length > 0) {
      // Same digest, no-op
      await client.query('COMMIT');
      return {
        status: 'already-imported',
        digest,
        counts: { settings: 0, media: 0, savedSearches: 0 },
      };
    }

    // Check target tables for existing data
    const settingsCountResult = await client.query(
      'SELECT COUNT(*) AS cnt FROM app_settings',
    );
    const settingsCount = parseInt(settingsCountResult.rows[0].cnt, 10);
    if (settingsCount > 0) {
      throw new ValidationError(
        `Target app_settings already has ${settingsCount} row(s)`,
      );
    }

    const mediaCountResult = await client.query(
      'SELECT COUNT(*) AS cnt FROM media_items',
    );
    const mediaCount = parseInt(mediaCountResult.rows[0].cnt, 10);
    if (mediaCount > 0) {
      throw new ValidationError(
        `Target media_items already has ${mediaCount} row(s)`,
      );
    }

    const stateCountResult = await client.query(
      'SELECT COUNT(*) AS cnt FROM media_index_state',
    );
    const stateCount = parseInt(stateCountResult.rows[0].cnt, 10);
    if (stateCount > 0) {
      throw new ValidationError(
        `Target media_index_state already has ${stateCount} row(s)`,
      );
    }

    const savedSearchCountResult = await client.query(
      'SELECT COUNT(*) AS cnt FROM saved_searches',
    );
    const savedSearchCount = parseInt(savedSearchCountResult.rows[0].cnt, 10);
    if (savedSearchCount > 0) {
      throw new ValidationError(
        `Target saved_searches already has ${savedSearchCount} row(s)`,
      );
    }

    const importRunsCountResult = await client.query(
      'SELECT COUNT(*) AS cnt FROM import_runs',
    );
    const importRunsCount = parseInt(importRunsCountResult.rows[0].cnt, 10);
    if (importRunsCount > 0) {
      throw new ValidationError(
        `Target import_runs already has ${importRunsCount} row(s)`,
      );
    }

    // Step 5: Import data in the transaction
    // 5a: Import app_settings
    const settingsEncoded = encodeSettings(settingsSnapshot);
    await client.query(
      `INSERT INTO app_settings (id, data, revision) VALUES (1, $1, 1)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, revision = app_settings.revision + 1`,
      [settingsEncoded.data],
    );

    // 5b: Import media via staging helper (which operates in the caller's transaction)
    // 5b: Pass the source generatedAt and version from the snapshot.
    await replaceMediaInTransaction(
      client,
      mediaIndexSnapshot.files,
      mediaIndexSnapshot.generatedAt,
      mediaIndexSnapshot.version,
    );

    // 5c: Import saved searches (preserving IDs and timestamps)
    for (const search of savedSearchesSnapshot) {
      const row = encodeSavedSearch(search);
      await client.query(
        `INSERT INTO saved_searches (id, name, query, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           query = EXCLUDED.query,
           updated_at = EXCLUDED.updated_at`,
        [row.id, row.name, row.query, row.created_at, row.updated_at],
      );
    }

    // Step 6: Record import in import_runs
    await client.query(
      `INSERT INTO import_runs (source_digest, source_schema, imported_at, settings_count, media_count, saved_search_count)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        digest,
        'onefolder-json-v1',
        clock(),
        1, // Always 1 settings row inserted
        mediaIndexSnapshot.files.length,
        savedSearchesSnapshot.length,
      ],
    );

    await client.query('COMMIT');

    return {
      status: 'imported',
      digest,
      counts: {
        settings: 1,
        media: mediaIndexSnapshot.files.length,
        savedSearches: savedSearchesSnapshot.length,
      },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Validate the MediaIndex envelope shape exactly.
 */
function validateMediaIndexEnvelope(index: MediaIndex): void {
  // Enforce plain object (no arrays, nulls, or non-objects)
  if (typeof index !== 'object' || index === null || Array.isArray(index)) {
    throw new ValidationError('MediaIndex must be a plain object');
  }

  // Enforce exactly keys "version" and "generatedAt" and "files"
  const indexKeys = new Set(Object.keys(index));
  if (indexKeys.size !== 3 ||
      !indexKeys.has('version') || !indexKeys.has('generatedAt') || !indexKeys.has('files')) {
    throw new ValidationError('MediaIndex must have exactly version, generatedAt, files keys');
  }

  // Validate version: must be exactly 1
  if (typeof index.version !== 'number' || !Number.isInteger(index.version) || index.version !== 1) {
    throw new ValidationError('MediaIndex version must be exactly 1');
  }

  // Validate generatedAt: must be a canonical ISO timestamp string
  if (typeof index.generatedAt !== 'string') {
    throw new ValidationError('MediaIndex generatedAt must be a string');
  }
  const generatedAtDate = new Date(index.generatedAt);
  if (isNaN(generatedAtDate.getTime()) || generatedAtDate.toISOString() !== index.generatedAt) {
    throw new ValidationError('MediaIndex generatedAt must be a canonical ISO timestamp');
  }

  // Validate files: must be an array
  if (!Array.isArray(index.files)) {
    throw new ValidationError('MediaIndex files must be an array');
  }

  // Validate each MediaItem
  const idSet = new Set<string>();
  for (const item of index.files) {
    validateMediaItem(item);
    if (idSet.has(item.id)) {
      throw new ValidationError(`Duplicate media item id: ${item.id}`);
    }
    idSet.add(item.id);
  }
}

/**
 * Validate a MediaItem against the exact required/optional type constraints.
 */
function validateMediaItem(item: MediaItem): void {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw new ValidationError('MediaItem must be a plain object');
  }

  // Check all required keys present and reject any extra keys
  const requiredKeys: string[] = [
    'id', 'libraryId', 'libraryName', 'relativePath', 'folder', 'name',
    'extension', 'kind', 'mimeType', 'size', 'createdAt', 'modifiedAt',
    'indexedAt', 'tags', 'description', 'artist', 'thumbnailUrl',
    'previewThumbnailUrl', 'fileUrl',
  ];
  // Only allowed optional keys are width, height, durationSeconds
  const allowedKeys = new Set([...requiredKeys, 'width', 'height', 'durationSeconds']);
  for (const key of Object.keys(item)) {
    if (!allowedKeys.has(key)) {
      throw new ValidationError(`MediaItem has unknown key "${key}"`);
    }
  }
  for (const key of requiredKeys) {
    if (!(key in item)) {
      throw new ValidationError(`MediaItem missing required key "${key}"`);
    }
  }

  // Validate id: nonempty trimmed string
  if (typeof item.id !== 'string' || item.id.trim() === '' || item.id !== item.id.trim()) {
    throw new ValidationError('MediaItem id must be a nonempty trimmed string');
  }

  // Validate kind: must be one of "image", "video", "text", "file"
  if (!['image', 'video', 'text', 'file'].includes(item.kind)) {
    throw new ValidationError(`MediaItem kind must be image|video|text|file, got "${item.kind}"`);
  }

  // Validate size: must be a safe nonnegative integer
  if (typeof item.size !== 'number' || !Number.isInteger(item.size) || item.size < 0 ||
      item.size > Number.MAX_SAFE_INTEGER) {
    throw new ValidationError(`MediaItem size must be a safe nonnegative integer`);
  }

  // Optional width: must be a finite positive integer <= 2147483647 if present
  if (item.width !== undefined) {
    if (typeof item.width !== 'number' || !Number.isInteger(item.width) || item.width < 1 || item.width > 2147483647) {
      throw new ValidationError('MediaItem width must be a finite positive integer <= 2147483647 if present');
    }
  }

  // Optional height: must be a finite positive integer <= 2147483647 if present
  if (item.height !== undefined) {
    if (typeof item.height !== 'number' || !Number.isInteger(item.height) || item.height < 1 || item.height > 2147483647) {
      throw new ValidationError('MediaItem height must be a finite positive integer <= 2147483647 if present');
    }
  }

  // Optional durationSeconds: must be a finite positive number if present
  if (item.durationSeconds !== undefined) {
    if (typeof item.durationSeconds !== 'number' || item.durationSeconds <= 0 || !Number.isFinite(item.durationSeconds)) {
      throw new ValidationError('MediaItem durationSeconds must be a finite positive number if present');
    }
  }

  // Validate tags: must be an array of strings
  if (!Array.isArray(item.tags)) {
    throw new ValidationError('MediaItem tags must be an array');
  }
  for (const tag of item.tags) {
    if (typeof tag !== 'string') {
      throw new ValidationError('MediaItem tags items must be strings');
    }
    if (tag.trim() === '' || tag !== tag.trim()) {
      throw new ValidationError('MediaItem tags items must be nonempty trimmed strings');
    }
  }

  // Validate all string fields: must be strings; for path/name/extension/mimeType preserve whitespace
  const stringFields = [
    'libraryId', 'libraryName', 'relativePath', 'folder', 'name', 'extension',
    'mimeType', 'createdAt', 'modifiedAt', 'indexedAt', 'description',
    'artist', 'thumbnailUrl', 'previewThumbnailUrl', 'fileUrl',
  ];
  for (const key of stringFields) {
    if (typeof item[key as keyof MediaItem] !== 'string') {
      throw new ValidationError(`MediaItem "${key}" must be a string`);
    }
    // For path/name/extension/mimeType, allow whitespace but ensure not empty
    if (['relativePath', 'name', 'extension', 'mimeType'].includes(key)) {
      const val = item[key as keyof MediaItem] as string;
      if (val === '') {
        throw new ValidationError(`MediaItem "${key}" must not be empty`);
      }
    }
    // Allow folder to be empty for root-level files
    if (key === 'folder') {
      // folder may be empty string for root files, fine
    }
  }
}
