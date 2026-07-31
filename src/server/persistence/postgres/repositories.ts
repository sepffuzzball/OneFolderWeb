/**
 * PostgreSQL implementations of SettingsRepository, MediaIndexRepository,
 * and SavedSearchRepository.
 *
 * Each repository accepts a pg.Pool and deterministic clock/id/defaults
 * injection.
 */

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { AppSettings, MediaItem, SavedSearch } from '../../../shared/types.js';
import type { SavedSearchInput } from '../../../shared/types.js';
import type {
  SettingsRepository,
  MediaIndexRepository,
  SavedSearchRepository,
  MediaIndex,
} from '../repositories.js';
import {
  encodeSettings,
  decodeSettingsRow,
  encodeMediaIndexState,
  decodeMediaIndexStateRow,
  encodeMediaItem,
  decodeMediaItemRow,
  encodeSavedSearch,
  decodeSavedSearchRow,
  MEDIA_COLUMN_COUNT,
} from './codec.js';
import { normalizeSettings, normalizeSettingsForLoad } from '../settings-normalization.js';

/**
 * Advisory lock key used for serializing full media replacement operations.
 */
export const MEDIA_REPLACEMENT_LOCK_KEY = 42;

/**
 * Persistence-wide advisory lock key used for exclusive import operations
 * and shared for normal write transactions.
 */
export const PERSISTENCE_LOCK_KEY = 42;

/**
 * PostgresSettingsRepository: implements SettingsRepository with PostgreSQL.
 *
 * Uses the fixed singleton id=1. load/save/update each use one acquired client
 * with explicit BEGIN/COMMIT/ROLLBACK.
 * Safe absent-row initialization is handled via last-resort INSERT.
 */
export class PostgresSettingsRepository implements SettingsRepository {
  readonly #pool: pg.Pool;
  readonly #normalize: (settings: AppSettings) => AppSettings;
  readonly #normalizeForLoad: (settings: AppSettings, defaultLibraryPath: string) => AppSettings;
  readonly #defaultSettings: () => AppSettings;
  readonly #clock: () => string;
  readonly #defaultLibraryPath: string;

  constructor(opts: {
    pool: pg.Pool;
    defaults: { defaultSettings: () => AppSettings };
    clock?: () => string;
    normalize?: (settings: AppSettings) => AppSettings;
    defaultLibraryPath: string;
  }) {
    this.#pool = opts.pool;
    this.#normalize = opts.normalize ?? normalizeSettings;
    this.#normalizeForLoad = normalizeSettingsForLoad;
    this.#defaultSettings = opts.defaults.defaultSettings;
    this.#clock = opts.clock ?? (() => new Date().toISOString());
    this.#defaultLibraryPath = opts.defaultLibraryPath;
  }

  async load(): Promise<AppSettings> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      // Read the singleton app_settings row with id=1
      const result = await client.query(
        'SELECT id, revision, data FROM app_settings WHERE id = $1',
        [1],
      );
      if (result.rows.length === 1) {
        const raw = decodeSettingsRow(result.rows[0]);
        // Apply normalizeSettingsForLoad to the loaded data
        const settings = this.#normalizeForLoad(raw, this.#defaultLibraryPath);
        await client.query('COMMIT');
        return settings;
      }

      // No row found - return a detached exact default without writing
      // (matches spec requirement)
      const defaults = this.#defaultSettings();
      const normalized = this.#normalize(defaults);
      await client.query('COMMIT');
      return normalized;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    const normalized = this.#normalize(settings);
    const encoded = encodeSettings(normalized);

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      // Acquire shared advisory lock
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [PERSISTENCE_LOCK_KEY]);

      // INSERT id=1, data, revision=1 with ON CONFLICT DO UPDATE
      await client.query(
        `INSERT INTO app_settings (id, data, revision) VALUES (1, $1, 1)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, revision = app_settings.revision + 1`,
        [encoded.data],
      );

      await client.query('COMMIT');
      return normalized;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(
    mutator: (current: Readonly<AppSettings>) => AppSettings,
  ): Promise<AppSettings> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Acquire shared advisory lock
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [PERSISTENCE_LOCK_KEY]);

      // First seed id=1 defaults with ON CONFLICT DO NOTHING to prevent
      // race conditions on absent rows.
      const defaults = this.#defaultSettings();
      const defaultEncoded = encodeSettings(this.#normalize(defaults));
      await client.query(
        `INSERT INTO app_settings (id, data, revision) VALUES (1, $1, 0)
         ON CONFLICT (id) DO NOTHING`,
        [defaultEncoded.data],
      );

      // SELECT id=1 FOR UPDATE to lock
      const result = await client.query(
        'SELECT id, revision, data FROM app_settings WHERE id = $1 FOR UPDATE',
        [1],
      );
      if (result.rows.length === 0) {
        // Should never happen after the seed above, but safeguard
        throw new Error('app_settings row id=1 not found after seed');
      }

      const currentRow = result.rows[0];
      const current = this.#normalizeForLoad(
        decodeSettingsRow(currentRow),
        this.#defaultLibraryPath,
      );

      // The mutator receives a detached readonly snapshot.
      const mutated = mutator(Object.freeze(current) as Readonly<AppSettings>);
      const normalized = this.#normalize(mutated);
      const encoded = encodeSettings(normalized);

      // Update id=1 revision = revision + 1
      await client.query(
        `UPDATE app_settings SET data = $1, revision = app_settings.revision + 1 WHERE id = 1`,
        [encoded.data],
      );

      await client.query('COMMIT');
      return normalized;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * PostgresMediaIndexRepository: implements MediaIndexRepository.
 *
 * save uses a single transaction, a TEMP staging table, chunked parameterized
 * inserts below 65535, global position derived as chunkStart+localIndex,
 * full replacement by DELETE all + INSERT all stage rows, and upsert id=1
 * state with version=1/current injected clock.
 * Empty and nonempty save both return the same current clock and exact
 * detached snapshot.
 * Load reads id=1 state and rows by position; absent state fallback to epoch.
 */
/**
 * Client-aware helper: create the media_staging temp table.
 *
 * This is exported so import code can reuse the same schema without
 * duplicating the column definitions. All 23 columns match the original
 * media_items columns plus position.
 */
export function createMediaStagingTableSQL(): string {
  return `
    CREATE TEMP TABLE media_staging (
      id                  TEXT,
      library_id          TEXT,
      library_name        TEXT,
      relative_path       TEXT,
      folder              TEXT,
      name                TEXT,
      extension           TEXT,
      kind                TEXT,
      mime_type           TEXT,
      size                BIGINT,
      width               INTEGER,
      height              INTEGER,
      duration_seconds    DOUBLE PRECISION,
      created_at          TEXT,
      modified_at         TEXT,
      indexed_at          TEXT,
      tags                JSONB,
      description         TEXT,
      artist              TEXT,
      thumbnail_url       TEXT,
      preview_thumbnail_url TEXT,
      file_url            TEXT,
      position            INTEGER
    )
  `;
}

/**
 * Client-aware helper: encode a MediaItem row with 23-column parameterized
 * values, including the global position derived from the array index.
 *
 * This matches encodeMediaItem from codec.ts but is exported here so import
 * code can reuse the same column order without duplicating it.
 */
export function encodeMediaItemForStaging(
  item: MediaItem,
  globalPosition: number,
): Record<string, unknown> {
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
    position: globalPosition,
  };
}

export class PostgresMediaIndexRepository implements MediaIndexRepository {
  readonly #pool: pg.Pool;
  readonly #clock: () => string;

  constructor(opts: {
    pool: pg.Pool;
    clock?: () => string;
  }) {
    this.#pool = opts.pool;
    this.#clock = opts.clock ?? (() => new Date().toISOString());
  }

  async load(): Promise<MediaIndex> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

      // Read media index state (singleton id=1)
      const stateResult = await client.query(
        'SELECT id, version, generated_at FROM media_index_state WHERE id = $1',
        [1],
      );
      let state: { version: number; generatedAt: string } | undefined;
      if (stateResult.rows.length === 1) {
        state = decodeMediaIndexStateRow(stateResult.rows[0]);
      }

      // Read all media items ordered by position
      const itemsResult = await client.query(
        'SELECT * FROM media_items ORDER BY position ASC',
      );

      // Decode each row
      const files = itemsResult.rows.map((row: any) => decodeMediaItemRow(row));

      // Build the MediaIndex object
      const index: MediaIndex = state
        ? { version: state.version, generatedAt: state.generatedAt, files }
        : { version: 1, generatedAt: new Date(0).toISOString(), files };

      await client.query('COMMIT');
      return index;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async save(files: readonly MediaItem[]): Promise<MediaIndex> {
    const snapshot = structuredClone(files) as MediaItem[];
    const now = this.#clock();

    // Both empty and non-empty: use replaceMediaInTransaction helper which does
    // stage/delete/insert/state on the caller's transaction.
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      // Acquire transaction-level advisory lock (exclusive)
      await client.query('SELECT pg_advisory_xact_lock($1)', [PERSISTENCE_LOCK_KEY]);

      // Use the refactored helper (which does stage/delete/insert/state on the caller's transaction)
      await replaceMediaInTransaction(client, snapshot, now);

      await client.query('COMMIT');
      return {
        version: 1,
        generatedAt: now,
        files: snapshot,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * PostgresSavedSearchRepository: implements SavedSearchRepository.
 *
 * CRUD is transactional and detached. update preserves id/createdAt.
 * Uses randomUUID for production ID generation.
 */
export class PostgresSavedSearchRepository implements SavedSearchRepository {
  readonly #pool: pg.Pool;
  readonly #clock: () => string;
  readonly #idGenerator: () => string;

  constructor(opts: {
    pool: pg.Pool;
    clock?: () => string;
    idGenerator?: () => string;
  }) {
    this.#pool = opts.pool;
    this.#clock = opts.clock ?? (() => new Date().toISOString());
    this.#idGenerator = opts.idGenerator ?? (() => randomUUID());
  }

  #deepClone<T>(value: T): T {
    return structuredClone(value);
  }

  async list(): Promise<SavedSearch[]> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'SELECT id, name, query, created_at, updated_at FROM saved_searches ORDER BY name ASC, id ASC',
      );
      const items = result.rows.map((row: any) => decodeSavedSearchRow(row));

      await client.query('COMMIT');
      // Deterministic order: name localeCompare then id (JS semantics)
      // Already sorted by SQL, but apply JS sort for consistency
      return items.sort((a: SavedSearch, b: SavedSearch) =>
        a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ).map((item: SavedSearch) => this.#deepClone(item));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<SavedSearch | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        'SELECT id, name, query, created_at, updated_at FROM saved_searches WHERE id = $1',
        [id],
      );
      if (result.rows.length === 0) {
        await client.query('COMMIT');
        return undefined;
      }
      const row = result.rows[0];
      const item = decodeSavedSearchRow(row);

      await client.query('COMMIT');
      return this.#deepClone(item);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async create(input: SavedSearchInput): Promise<SavedSearch> {
    const clampedInput = this.#deepClone(input);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Acquire shared advisory lock
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [PERSISTENCE_LOCK_KEY]);

      const id = this.#idGenerator();
      const now = this.#clock();
      const item: SavedSearch = {
        id,
        createdAt: now,
        updatedAt: now,
        name: clampedInput.name,
        query: clampedInput.query,
      };
      const row = encodeSavedSearch(item);
      await client.query(
        `INSERT INTO saved_searches (id, name, query, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
        [row.id, row.name, row.query, row.created_at, row.updated_at],
      );

      await client.query('COMMIT');
      return this.#deepClone(item);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async update(id: string, input: SavedSearchInput): Promise<SavedSearch | undefined> {
    const clampedInput = this.#deepClone(input);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Acquire shared advisory lock
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [PERSISTENCE_LOCK_KEY]);

      // Find existing
      const findResult = await client.query(
        'SELECT id, name, query, created_at, updated_at FROM saved_searches WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (findResult.rows.length === 0) {
        await client.query('COMMIT');
        return undefined;
      }

      const existingRow = findResult.rows[0];
      const existing = decodeSavedSearchRow(existingRow);
      const now = this.#clock();
      const updated: SavedSearch = {
        ...existing,
        name: clampedInput.name,
        query: clampedInput.query,
        updatedAt: now,
        // id and createdAt are preserved
      };
      const row = encodeSavedSearch(updated);
      await client.query(
        `UPDATE saved_searches SET name = $2, query = $3, updated_at = $4 WHERE id = $1`,
        [row.id, row.name, row.query, row.updated_at],
      );

      await client.query('COMMIT');
      return this.#deepClone(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async delete(id: string): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Acquire shared advisory lock
      await client.query('SELECT pg_advisory_xact_lock_shared($1)', [PERSISTENCE_LOCK_KEY]);

      const result = await client.query(
        'DELETE FROM saved_searches WHERE id = $1',
        [id],
      );
      const deleted = result.rowCount! > 0;

      await client.query('COMMIT');
      return deleted;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

/**
 * Client-aware helper: perform a full media replacement using a staging table.
 *
 * This helper is exported so import code can reuse the same staging logic
 * without duplicating the INSERT/DELETE/DROP sequence.
 *
 * It takes a pg.PoolClient and the new media items array (in order), and
 * executes the full replacement transaction (advisory lock, staging table,
 * DELETE old, INSERT new, drop staging, upsert state).
 *
 * The function returns the generatedAt clock string used.
 */
/**
 * Client-aware helper: perform a full media replacement using a staging table.
 *
 * This helper is exported so import code can reuse the same staging logic
 * without duplicating the INSERT/DELETE/DROP sequence.
 *
 * It takes a pg.PoolClient and the new media items array (in order), and
 * executes the full replacement (staging table, DELETE old, INSERT new,
 * drop staging, upsert state) - all within the caller's transaction.
 *
 * The helper does NOT acquire an advisory lock, as the caller owns the
 * transaction-level lock. It also does NOT begin/commit/rollback its own
 * transaction; the caller handles that.
 *
 * The function takes the generatedAt and version that were already
 * computed by the caller and persists them directly, never calling a clock.
 */
export async function replaceMediaInTransaction(
  client: pg.PoolClient,
  files: readonly MediaItem[],
  generatedAt: string,
  version: number = 1,
): Promise<void> {
  const snapshot = structuredClone(files) as MediaItem[];

  if (snapshot.length === 0) {
    // Empty replacement: remove all rows and set empty state with id=1
    await client.query('DELETE FROM media_items');
    await client.query(
      `INSERT INTO media_index_state (id, version, generated_at) VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE SET version = $1, generated_at = $2`,
      [version, generatedAt],
    );
    return;
  }

  // Non-empty replacement: use a TEMP staging table
  await client.query(createMediaStagingTableSQL());

  // Chunked inserts
  const CHUNK_SIZE = Math.floor(65535 / MEDIA_COLUMN_COUNT);
  const chunks: MediaItem[][] = [];
  for (let i = 0; i < snapshot.length; i += CHUNK_SIZE) {
    chunks.push(snapshot.slice(i, i + CHUNK_SIZE));
  }

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
    const chunk = chunks[chunkIdx];
    const placeholders: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i];
      const globalPos = chunkIdx * CHUNK_SIZE + i;
      const row = encodeMediaItemForStaging(item, globalPos);
      const values = Object.values(row);
      const offset = i * MEDIA_COLUMN_COUNT;
      placeholders.push(
        `(${values.map((_, vi) => `$${offset + vi + 1}`).join(',')})`,
      );
      params.push(...values);
    }
    await client.query(
      `INSERT INTO media_staging VALUES ${placeholders.join(',')}`,
      params,
    );
  }

  // DELETE all existing media_items
  await client.query('DELETE FROM media_items');

  // INSERT all from staging
  await client.query(
    `INSERT INTO media_items SELECT * FROM media_staging`,
  );

  // Drop staging table
  await client.query('DROP TABLE media_staging');

  // Upsert state using the given version and generatedAt
  await client.query(
    `INSERT INTO media_index_state (id, version, generated_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET version = $1, generated_at = $2`,
    [version, generatedAt],
  );
}
