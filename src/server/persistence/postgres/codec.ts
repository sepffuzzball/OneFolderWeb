/**
 * Codecs for encoding/decoding between the database row types and
 * the TypeScript domain types used by the repository implementations.
 *
 * All codec functions are exported for testing.
 */

import type { AppSettings, MediaItem, SavedSearch } from '../../../shared/types.js';
import type { SavedSearchQuery } from '../../../shared/types.js';
import type { MediaIndex } from '../repositories.js';

/* ===================================================================
 *  Settings codec: encodes AppSettings (with normalization) into
 *  JSONB+revision, decodes JSONB+revision back to AppSettings.
 * ===================================================================
 */

export type SettingsRow = {
  id: number;
  data: string; // JSONB string (or parsed object)
  revision: number;
};

export type SettingsInput = {
  data: string; // JSONB string, will be passed as $1 parameter
};

/**
 * Encode AppSettings into a SettingsInput.
 * The data field is always a JSON string of the settings object.
 */
export function encodeSettings(settings: AppSettings): SettingsInput {
  // Ensure we always produce a JSON string for the ::jsonb cast
  if (typeof settings === 'string') {
    return { data: settings };
  }
  return { data: JSON.stringify(settings) };
}

/**
 * Decode a SettingsRow (which may include a parsed JSONB object from pg)
 * back into an AppSettings. If row.data is already an object (from pg),
 * use it directly; otherwise parse the JSON string.
 */
export function decodeSettingsRow(row: SettingsRow): AppSettings {
  let data: AppSettings;
  if (typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)) {
    data = row.data as AppSettings;
  } else if (typeof row.data === 'string') {
    data = JSON.parse(row.data) as AppSettings;
  } else {
    throw new Error(`Settings row data is neither object nor string: ${typeof row.data}`);
  }
  return data;
}

/* ===================================================================
 *  Media index state codec: encodes version + generated_at into
 *  the singleton state row, decodes back.
 * ===================================================================
 */

export type MediaIndexStateRow = {
  id: number;
  version: number;
  generated_at: string;
};

export function encodeMediaIndexState(state: MediaIndex): MediaIndexStateRow {
  return {
    id: 1,
    version: state.version,
    generated_at: state.generatedAt,
  };
}

export function decodeMediaIndexStateRow(
  row: MediaIndexStateRow,
): { version: number; generatedAt: string } {
  return {
    version: row.version,
    generatedAt: row.generated_at ?? '',
  };
}

/* ===================================================================
 *  MediaItem codec: encodes a MediaItem into a row for the media_items
 *  table. The `position` column is derived from the global index in the
 *  staged/committed array, never from indexOf.
 * ===================================================================
 */

/** Number of columns in the media_items table (including position). */
export const MEDIA_COLUMN_COUNT = 23;

export type MediaItemRow = {
  id: string;
  library_id: string;
  library_name: string;
  relative_path: string;
  folder: string;
  name: string;
  extension: string;
  kind: string;
  mime_type: string;
  size: string; // BIGINT, stored as string
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  created_at: string;
  modified_at: string;
  indexed_at: string;
  tags: string; // JSONB string
  description: string;
  artist: string;
  thumbnail_url: string;
  preview_thumbnail_url: string;
  file_url: string;
  position: number;
};

/**
 * Encode a MediaItem into a row, with the given global position.
 * The position is the array index after sorting by order; it is never
 * derived from indexOf on the snapshot array.
 */
export function encodeMediaItem(item: MediaItem, position: number): MediaItemRow {
  // Validate size: must be a non-negative integer, and not exceed MAX_SAFE_INTEGER
  const sizeNum = item.size;
  if (!Number.isInteger(sizeNum) || sizeNum < 0 || sizeNum > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid media item size: ${sizeNum}`);
  }

  return {
    id: item.id,
    library_id: item.libraryId,
    library_name: item.libraryName,
    relative_path: item.relativePath,
    folder: item.folder,
    name: item.name,
    extension: item.extension,
    kind: item.kind,
    mime_type: item.mimeType,
    size: String(item.size),
    width: item.width ?? null,
    height: item.height ?? null,
    duration_seconds: item.durationSeconds ?? null,
    created_at: item.createdAt,
    modified_at: item.modifiedAt,
    indexed_at: item.indexedAt,
    tags: JSON.stringify(item.tags),
    description: item.description,
    artist: item.artist,
    thumbnail_url: item.thumbnailUrl,
    preview_thumbnail_url: item.previewThumbnailUrl,
    file_url: item.fileUrl,
    position,
  };
}

/**
 * Decode a MediaItemRow back into a MediaItem.
 * Validates shape and never silently replaces malformed tags JSON.
 * BIGINT size is always validated: must be non-negative integer string,
 * rejecting negative and >MAX_SAFE_INTEGER values.
 */
export function decodeMediaItemRow(row: MediaItemRow): MediaItem {
  // Validate size string: must be a non-negative integer string
  const sizeStr = row.size;
  if (typeof sizeStr !== 'string' || !/^\d+$/.test(sizeStr)) {
    throw new Error(`Invalid media item size string: "${sizeStr}"`);
  }
  const sizeNum = Number(sizeStr);
  if (sizeNum > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Media item size exceeds MAX_SAFE_INTEGER: ${sizeNum}`);
  }

  // Parse tags JSONB; must be a valid array of strings
  let tags: string[] = [];
  if (typeof row.tags === 'string') {
    try {
      tags = JSON.parse(row.tags) as string[];
    } catch {
      throw new Error(`Invalid tags JSON string for media item: "${row.tags}"`);
    }
  } else if (Array.isArray(row.tags)) {
    tags = row.tags as string[];
  } else {
    throw new Error(`Media item tags is neither string nor array: ${typeof row.tags}`);
  }
  // Validate all tags are strings
  if (!tags.every((t) => typeof t === 'string')) {
    throw new Error(`Media item tags contains non-string elements`);
  }

  return {
    id: row.id,
    libraryId: row.library_id,
    libraryName: row.library_name,
    relativePath: row.relative_path,
    folder: row.folder,
    name: row.name,
    extension: row.extension,
    kind: row.kind as MediaItem['kind'],
    mimeType: row.mime_type,
    size: sizeNum,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    tags,
    description: row.description,
    artist: row.artist,
    thumbnailUrl: row.thumbnail_url,
    previewThumbnailUrl: row.preview_thumbnail_url,
    fileUrl: row.file_url,
  };
}

/* ===================================================================
 *  SavedSearch codec: encodes SavedSearch into a row, decodes row
 *  back to SavedSearch. The `query` field is stored as JSONB.
 *  Validation enforces canonical constraints: actual parsed JSONB
 *  object accepted; malformed/unknown fields, noncanonical strings/
 *  timestamps, and tags+expression reject. Never default malformed
 *  query to {}.
 * ===================================================================
 */

export type SavedSearchRow = {
  id: string;
  name: string;
  query: string; // JSONB string (or parsed object)
  created_at: string;
  updated_at: string;
};

/**
 * Encode a SavedSearch into a row.
 */
export function encodeSavedSearch(search: SavedSearch): SavedSearchRow {
  // Ensure query is a string for ::jsonb cast
  return {
    id: search.id,
    name: search.name,
    query: typeof search.query === 'object' && search.query !== null && !Array.isArray(search.query)
      ? JSON.stringify(search.query)
      : String(search.query),
    created_at: search.createdAt,
    updated_at: search.updatedAt,
  };
}

/**
 * Decode a SavedSearchRow back into a SavedSearch.
 * Strict validation of row fields: id, name, query, created_at, updated_at.
 * Query must be a parsed JSONB object (not an array, not a string with
 * malformed content). Unknown fields in query are rejected. Noncanonical
 * timestamps are rejected. If tags and tagExpression both appear, reject.
 */
export function decodeSavedSearchRow(row: SavedSearchRow): SavedSearch {
  // --- id validation ---
  if (typeof row.id !== 'string' || !row.id.trim()) {
    throw new Error(`Invalid saved search id: "${row.id}"`);
  }

  // --- name validation ---
  const nameStr = row.name;
  if (typeof nameStr !== 'string' || !nameStr.trim()) {
    throw new Error(`Invalid saved search name: "${nameStr}"`);
  }
  if (nameStr.length > 120) {
    throw new Error(`Saved search name exceeds 120 characters: ${nameStr.length}`);
  }

  // --- query validation ---
  let query: SavedSearchQuery;
  if (typeof row.query === 'object' && row.query !== null && !Array.isArray(row.query)) {
    // Accept parsed JSONB object directly
    query = row.query as SavedSearchQuery;
  } else if (typeof row.query === 'string') {
    try {
      query = JSON.parse(row.query) as SavedSearchQuery;
    } catch {
      throw new Error(`Invalid saved search query JSON: "${row.query}"`);
    }
  } else {
    throw new Error(`Saved search query is neither object nor string: ${typeof row.query}`);
  }

  // Validate query shape: must be an object, not an array
  if (typeof query !== 'object' || query === null || Array.isArray(query)) {
    throw new Error(`Saved search query must be an object, got ${typeof query}`);
  }

  // Reject unknown keys
  const ALLOWED_QUERY_KEYS = ['q', 'tags', 'tagExpression', 'folder', 'libraryId'];
  for (const key of Object.keys(query)) {
    if (!ALLOWED_QUERY_KEYS.includes(key)) {
      throw new Error(`Unknown key in saved search query: "${key}"`);
    }
  }

  // Validate q: must be a non-empty string, max 1000 chars
  if ('q' in query && query.q !== undefined) {
    if (typeof query.q !== 'string' || !query.q.trim()) {
      throw new Error(`Invalid saved search query q: must be a non-empty string`);
    }
    if (query.q.length > 1000) {
      throw new Error(`Saved search query q exceeds 1000 characters: ${query.q.length}`);
    }
  }

  // Validate tags: must be an array of strings, non-empty, each <= 500 chars, max 100 entries
  // If tags key exists with undefined/null value, treat as absent
  if ('tags' in query && query.tags !== undefined && query.tags !== null) {
    if (!Array.isArray(query.tags)) {
      throw new Error(`Saved search query tags must be an array`);
    }
    if (query.tags.length === 0) {
      throw new Error(`Saved search query tags must be non-empty`);
    }
    if (query.tags.length > 100) {
      throw new Error(`Saved search query tags exceeds 100 entries`);
    }
    for (const tag of query.tags) {
      if (typeof tag !== 'string' || !tag.trim()) {
        throw new Error(`Invalid saved search query tag: must be a non-empty string`);
      }
      if (tag.length > 500) {
        throw new Error(`Saved search query tag exceeds 500 characters`);
      }
    }
  }

  // Validate tagExpression: must be a non-empty string, max 4000 chars
  if ('tagExpression' in query && query.tagExpression !== undefined) {
    if (typeof query.tagExpression !== 'string' || !query.tagExpression.trim()) {
      throw new Error(`Invalid saved search query tagExpression: must be a non-empty string`);
    }
    if (query.tagExpression.length > 4000) {
      throw new Error(`Saved search query tagExpression exceeds 4000 characters`);
    }
  }

  // Reject both tags and tagExpression
  if ('tags' in query && query.tags !== undefined && 'tagExpression' in query && query.tagExpression !== undefined) {
    throw new Error(`Saved search query cannot have both tags and tagExpression`);
  }

  // Validate folder: must be a non-empty string, max 1000 chars
  if ('folder' in query && query.folder !== undefined) {
    if (typeof query.folder !== 'string' || !query.folder.trim()) {
      throw new Error(`Invalid saved search query folder: must be a non-empty string`);
    }
    if (query.folder.length > 1000) {
      throw new Error(`Saved search query folder exceeds 1000 characters`);
    }
  }

  // Validate libraryId: must be a non-empty string, max 1000 chars
  if ('libraryId' in query && query.libraryId !== undefined) {
    if (typeof query.libraryId !== 'string' || !query.libraryId.trim()) {
      throw new Error(`Invalid saved search query libraryId: must be a non-empty string`);
    }
    if (query.libraryId.length > 1000) {
      throw new Error(`Saved search query libraryId exceeds 1000 characters`);
    }
  }

  // --- timestamp validation ---
  const validateTimestamp = (ts: string, field: string): void => {
    if (typeof ts !== 'string') {
      throw new Error(`Saved search ${field} must be a string`);
    }
    // Must be a valid ISO 8601 datetime string (including T and Z, with ms)
    if (ts.length === 0 || new Date(ts).toISOString() !== ts) {
      throw new Error(`Saved search ${field} has non-canonical format: "${ts}"`);
    }
  };
  validateTimestamp(row.created_at, 'created_at');
  validateTimestamp(row.updated_at, 'updated_at');

  return {
    id: row.id,
    name: row.name,
    query,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
