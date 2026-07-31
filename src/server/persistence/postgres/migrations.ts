import pg from 'pg';
import crypto from 'node:crypto';

/**
 * Migration definition.
 */
export type Migration = {
  name: string;
  sql: string;
  checksum: string;
};

/**
 * Check that a migration name is valid for ordering.
 */
const NAME_RE = /^[a-z0-9_-]+$/;
function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid migration name: "${name}"`);
  }
}

// Compute checksum from the exact SQL text at module construction.
// This ensures drift is always detected.
const checksumOf = (sql: string): string =>
  crypto.createHash('sha256').update(sql).digest('hex');

// Build a Migration object inline with computed checksum.
function migrationDef(name: string, sql: string): Migration {
  return { name, sql, checksum: checksumOf(sql) };
}

/**
 * Ordered list of PostgreSQL migrations. Must be in the exact order they
 * will be applied.
 */
export const POSTGRES_MIGRATIONS: readonly Migration[] = Object.freeze([
  migrationDef(
    '001-initial',
    inlineSql`
      -- schema_migrations table to track applied migrations
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT NOT NULL
      );

      -- singleton app_settings: fixed id, JSONB data, revision BIGINT
      CREATE TABLE app_settings (
        id       SMALLINT NOT NULL,
        data     JSONB NOT NULL DEFAULT '{}'::jsonb,
        revision BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        CONSTRAINT app_settings_singleton CHECK (id = 1)
      );

      -- singleton media_index_state: fixed id, version + generated_at TEXT
      CREATE TABLE media_index_state (
        id           SMALLINT NOT NULL,
        version      INTEGER NOT NULL DEFAULT 0,
        generated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (id),
        CONSTRAINT media_index_state_singleton CHECK (id = 1)
      );

      -- media_items: all MediaItem fields, nullable optionals, BIGINT size,
      -- TEXT IDs/timestamps/URLs, JSONB tags, integer position unique per-row
      CREATE TABLE media_items (
        id                  TEXT PRIMARY KEY,
        library_id          TEXT NOT NULL,
        library_name        TEXT NOT NULL,
        relative_path       TEXT NOT NULL,
        folder              TEXT NOT NULL,
        name                TEXT NOT NULL,
        extension           TEXT NOT NULL,
        kind                TEXT NOT NULL,
        mime_type           TEXT NOT NULL,
        size                BIGINT NOT NULL,
        width               INTEGER,
        height              INTEGER,
        duration_seconds    DOUBLE PRECISION,
        created_at          TEXT NOT NULL,
        modified_at         TEXT NOT NULL,
        indexed_at          TEXT NOT NULL,
        tags                JSONB NOT NULL DEFAULT '[]'::jsonb,
        description         TEXT NOT NULL DEFAULT '',
        artist              TEXT NOT NULL DEFAULT '',
        thumbnail_url       TEXT NOT NULL DEFAULT '',
        preview_thumbnail_url TEXT NOT NULL DEFAULT '',
        file_url            TEXT NOT NULL DEFAULT '',
        position            INTEGER NOT NULL UNIQUE
      );

      -- saved_searches: TEXT columns + query JSONB
      CREATE TABLE saved_searches (
        id         TEXT NOT NULL,
        name       TEXT NOT NULL,
        query      JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (id)
      );

      -- import_runs table tracking each import operation
      CREATE TABLE import_runs (
        source_digest    TEXT PRIMARY KEY,
        source_schema    TEXT NOT NULL,
        imported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        settings_count   INTEGER NOT NULL,
        media_count      BIGINT NOT NULL,
        saved_search_count INTEGER NOT NULL
      );
    `,
  ),
]);

/**
 * Apply all pending migrations under a single checked-out client,
 * using a transactional advisory lock and a transaction.
 *
 * Correct order:
 * 1. Acquire client.
 * 2. BEGIN.
 * 3. Acquire pg_advisory_xact_lock($1) inside the transaction.
 * 4. Create schema_migrations table if not exists (self-referencing).
 * 5. For each migration in order: check if already applied by name+checksum
 *    in schema_migrations; skip if match; else run SQL, record name+checksum.
 * 6. COMMIT (or ROLLBACK on failure).
 * 7. Release advisory lock automatically when transaction ends.
 *
 * Returns the number of migrations applied.
 */
export async function runPostgresMigrations(pool: pg.Pool): Promise<number> {
  // Use a deterministic session id for the advisory lock
  const sessionId = 1;

  let client: pg.PoolClient | undefined;
  let appliedCount = 0;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Acquire transaction-level advisory lock
    await client.query('SELECT pg_advisory_xact_lock($1)', [sessionId]);

    // Ensure schema_migrations table exists (should be part of migration 001,
    // but also create it here as a pre-check to allow self-referencing).
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        checksum TEXT NOT NULL
      );
    `);

    for (const migration of POSTGRES_MIGRATIONS) {
      const { name, sql, checksum } = migration;

      // Check if already applied
      const result = await client.query(
        `SELECT checksum FROM schema_migrations WHERE name = $1`,
        [name],
      );

      if (result.rows.length > 0) {
        const existingChecksum = result.rows[0].checksum;
        if (existingChecksum === checksum) {
          // Already applied and checksum matches, skip
          continue;
        }
        // Checksum mismatch - could indicate drift; treat as error
        throw new Error(
          `Migration "${name}" checksum mismatch: expected ${checksum}, got ${existingChecksum}`,
        );
      }

      // Apply the migration
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`,
        [name, checksum],
      );

      appliedCount++;
    }

    await client.query('COMMIT');
  } catch (err) {
    // Rollback on any error
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
    }
    throw err;
  } finally {
    if (client) {
      client.release();
    }
  }

  return appliedCount;
}

/**
 * Tag template helper to write inline SQL strings as raw text.
 */
function inlineSql(strings: TemplateStringsArray, ...values: unknown[]): string {
  // Inline SQL: just join the strings (no dynamic values in this function)
  return strings.join('');
}
