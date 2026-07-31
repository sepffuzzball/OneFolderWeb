/**
 * Export PostgreSQL data into JSON repositories.
 *
 * Reads all tables in a repeatable-read transaction, decodes with the same
 * strict codecs/load normalization, computes a semantic SHA-256 digest,
 * and writes pretty JSON files with trailing newlines to a new output directory.
 *
 * Output: `{outputDir, digest, counts}` where counts includes settings, media,
 * savedSearch count, and migrations list (with checksums).
 *
 * Steps:
 * 1. Acquire one client; BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ
 *    READ ONLY.
 * 2. Query app_settings (id=1), media_index_state (id=1), all media_items
 *    ordered by position, all saved_searches ordered by name ASC, id ASC,
 *    and all schema_migrations ordered by name.
 * 3. Decode each row using the same strict codecs and load normalization
 *    (settings uses normalizeSettingsForLoad, media uses decodeMediaItemRow,
 *    saved searches uses decodeSavedSearchRow).
 * 4. Compute a SHA-256 digest using the corrected helper from import-json.ts.
 * 5. COMMIT / ROLLBACK / release failure.
 * 6. Refuse if outputDir already exists (non-empty directory). Ensure only its
 *    parent exists, then mkdir outputDir non-recursively/exclusively.
 * 7. Atomically write (pretty JSON + trailing newline):
 *    - settings.json (exact AppSettings)
 *    - index.json ({version, generatedAt, files})
 *    - saved-searches.json ({version:1, items:[...]} with deterministic repo order)
 *    - manifest.json ({version:1, exportedAt, semanticDigest, counts, migrations})
 * 8. If any write fails, recursively remove only the newly created outputDir.
 * 9. Never inspect/modify active JSON files from the running application.
 */

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppSettings, MediaItem, SavedSearch } from '../../../shared/types.js';
import type { SettingsRepository, MediaIndexRepository, SavedSearchRepository, MediaIndex } from '../repositories.js';
import { ValidationError } from '../../validation.js';
import {
  decodeSettingsRow,
  decodeMediaIndexStateRow,
  decodeMediaItemRow,
  decodeSavedSearchRow,
} from './codec.js';
import { normalizeSettingsForLoad } from '../settings-normalization.js';
import { computeDigest } from './import-json.js';

export type ExportResult = {
  outputDir: string;
  digest: string;
  counts: {
    settings: 1;
    media: number;
    savedSearches: number;
  };
};

/**
 * Export PostgreSQL data to JSON files in a new output directory.
 */
export async function exportPostgresToJson(
  opts: {
    pool: pg.Pool;
    outputDir: string;
    defaultSettings: () => AppSettings;
    defaultLibraryPath: string;
    clock?: () => string;
  },
): Promise<ExportResult> {
  const clock = opts.clock ?? (() => new Date().toISOString());
  const settingsDefaults = opts.defaultSettings;

  // Step 0: Reject if final outputDir already exists (before DB query)
  if (fs.existsSync(opts.outputDir)) {
    throw new ValidationError(
      `Output directory "${opts.outputDir}" already exists`,
    );
  }

  // Use a unique exclusive sibling staging directory
  const parentDir = path.dirname(opts.outputDir);
  const stagingDirBaseName = path.basename(opts.outputDir);
  const stagingDirName = stagingDirBaseName + '.staging-' + crypto.randomUUID();
  const stagingDir = path.join(parentDir, stagingDirName);
  let stagingCreated = false;
  let filesWritten: string[] = [];

  // Step 1: Acquire client and begin repeatable-read read-only transaction
  const client = await opts.pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');

    // Step 2a: Read app_settings singleton
    let settings: AppSettings;
    const settingsResult = await client.query(
      'SELECT id, revision, data FROM app_settings WHERE id = $1',
      [1],
    );
    if (settingsResult.rows.length === 1) {
      const rawRow = decodeSettingsRow(settingsResult.rows[0]);
      settings = normalizeSettingsForLoad(rawRow, opts.defaultLibraryPath);
    } else {
      // No row: return a detached exact default
      settings = normalizeSettingsForLoad(settingsDefaults(), opts.defaultLibraryPath);
    }

    // Step 2b: Read media_index_state singleton
    let mediaState: { version: number; generatedAt: string } | undefined;
    const stateResult = await client.query(
      'SELECT id, version, generated_at FROM media_index_state WHERE id = $1',
      [1],
    );
    if (stateResult.rows.length === 1) {
      mediaState = decodeMediaIndexStateRow(stateResult.rows[0]);
    }

    // Step 2c: Read all media_items ordered by position
    const mediaResult = await client.query(
      'SELECT * FROM media_items ORDER BY position ASC',
    );
    const files: MediaItem[] = mediaResult.rows.map((row: any) => decodeMediaItemRow(row));

    // Step 2d: Read all saved_searches ordered by name ASC, id ASC
    const savedResult = await client.query(
      'SELECT id, name, query, created_at, updated_at FROM saved_searches ORDER BY name ASC, id ASC',
    );
    const savedSearches: SavedSearch[] = savedResult.rows.map((row: any) => decodeSavedSearchRow(row));

    // Step 2e: Read all schema_migrations ordered by name
    const migrationsResult = await client.query(
      'SELECT name, checksum FROM schema_migrations ORDER BY name ASC',
    );
    const migrations: { name: string; checksum: string }[] = migrationsResult.rows;

    // Build the MediaIndex for digest computation
    const mediaIndex: MediaIndex = mediaState
      ? { version: mediaState.version, generatedAt: mediaState.generatedAt, files }
      : { version: 1, generatedAt: new Date(0).toISOString(), files };

    // Step 3: Compute digest using the same helper
    const digest = computeDigest(settings, mediaIndex, savedSearches);

    // Step 4: COMMIT
    await client.query('COMMIT');

    // Step 5: Create staging directory exclusively
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.mkdirSync(stagingDir, { recursive: false });
    stagingCreated = true;

    // Step 6: Write files into staging directory atomically (use temp + rename within staging)
    const now = clock();

    // Helper to write a file with pretty JSON + trailing newline, then rename
    async function writeFile(targetPath: string, content: string): Promise<void> {
      const tempPath = targetPath + '.tmp.' + crypto.randomUUID();
      try {
        await fs.promises.writeFile(tempPath, content, 'utf8');
        await fs.promises.rename(tempPath, targetPath);
        filesWritten.push(targetPath);
      } catch (err) {
        // If rename fails, try to clean up temp
        try { await fs.promises.rm(tempPath, { force: true }).catch(() => undefined); } catch {}
        throw err;
      }
    }

    // settings.json
    const settingsContent = `${JSON.stringify(settings, null, 2)}\n`;
    await writeFile(path.join(stagingDir, 'settings.json'), settingsContent);

    // index.json
    const indexContent = `${JSON.stringify(mediaIndex, null, 2)}\n`;
    await writeFile(path.join(stagingDir, 'index.json'), indexContent);

    // saved-searches.json
    const savedEnvelope = { version: 1, items: savedSearches };
    const savedContent = `${JSON.stringify(savedEnvelope, null, 2)}\n`;
    await writeFile(path.join(stagingDir, 'saved-searches.json'), savedContent);

    // manifest.json
    const manifest = {
      version: 1,
      exportedAt: now,
      semanticDigest: digest,
      counts: {
        settings: 1,
        media: files.length,
        savedSearches: savedSearches.length,
      },
      migrations: migrations.map((m) => ({ name: m.name, checksum: m.checksum })),
    };
    const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(path.join(stagingDir, 'manifest.json'), manifestContent);

    // Step 7: Re-check that final outputDir still does not exist (race safety)
    // If it now exists, fail, clean staging, and throw
    if (fs.existsSync(opts.outputDir)) {
      // Clean staging directory
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        stagingCreated = false;
      }
      throw new ValidationError(
        `Output directory "${opts.outputDir}" was created during export; clean staging and fail`,
      );
    }

    // Atomically rename staging directory to final output directory
    // Use renameSync (atomic on same filesystem)
    if (stagingDir !== opts.outputDir) {
      fs.renameSync(stagingDir, opts.outputDir);
    }
    stagingCreated = false;

    return {
      outputDir: opts.outputDir,
      digest,
      counts: {
        settings: 1,
        media: files.length,
        savedSearches: savedSearches.length,
      },
    };
  } catch (err) {
    // Rollback on any error
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    // Clean up staging directory if created
    if (stagingCreated && fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        stagingCreated = false;
        filesWritten = [];
      } catch {
        // ignore cleanup errors
      }
    }
    throw err;
  } finally {
    client.release();
  }
}
