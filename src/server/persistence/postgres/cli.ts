/**
 * CLI tool for importing/exporting JSON repositories into/from PostgreSQL.
 *
 * Usage:
 *   npm run persistence:import-json    (import production JSON repos into Postgres)
 *   npm run persistence:export-json    (export Postgres data to JSON files)
 *
 * Additional arguments after the command:
 *   npm run persistence:export-json <output-path>
 *
 * Requires DATABASE_URL environment variable.
 * Uses shared strict Postgres env config to create a pool,
 * runs migrations, imports or exports from/to JSON files,
 * and ends the pool.
 */

import pg from 'pg';
import path from 'node:path';
import { parsePostgresEnv } from './config.js';
import { createPostgresPool } from './pool.js';
import { runPostgresMigrations } from './migrations.js';
import { importJsonIntoPostgres } from './import-json.js';
import { exportPostgresToJson } from './export-json.js';
import {
  settingsRepository,
  mediaIndexRepository,
  savedSearchesRepository,
} from '../json.js';
import { paths } from '../../config.js';

/**
 * Parse CLI arguments to determine which command to run.
 */
function parseArgs(): { command: string; outputPath?: string } {
  const args = process.argv.slice(2); // skip "tsx" and script path
  if (args.length === 0) {
    // Default to import
    return { command: 'import-json' };
  }
  const command = args[0];
  if (command === 'import-json') {
    return { command };
  }
  if (command === 'export-json') {
    const outputPath = args[1];
    return { command, outputPath };
  }
  // Unknown command
  console.error(`Unknown command: "${command}"`);
  console.error('Usage: npm run persistence:import-json OR npm run persistence:export-json [output-path]');
  process.exit(1);
  return { command: '' }; // unreachable
}

/**
 * Generate the default output directory name for export.
 */
function defaultExportOutputDir(): string {
  // UTC timestamp with colon/dot replaced by hyphen
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[:.]/g, '-');
  // Child of SETTINGS_DIR
  return path.join(paths.settingsDir, `postgres-export-${timestamp}`);
}

/**
 * Main CLI entry.
 */
async function main(): Promise<void> {
  const { command, outputPath } = parseArgs();

  // Parse environment
  const envConfig = parsePostgresEnv();

  // Create pool through credential-safe helper
  const pool = createPostgresPool({
    DATABASE_URL: envConfig.DATABASE_URL,
    poolMax: envConfig.poolMax,
    poolIdleTimeout: envConfig.poolIdleTimeout,
    poolConnectionTimeout: envConfig.poolConnectionTimeout,
  });

  let exitCode = 2;
  try {
    // Always run pending migrations first
    await runPostgresMigrations(pool);

    if (command === 'import-json') {
      // Import JSON data
      const result = await importJsonIntoPostgres({
        pool,
        settingsRepository,
        mediaIndexRepository,
        savedSearchRepository: savedSearchesRepository,
      });

      console.log(result.status === 'imported'
        ? `Imported: ${result.counts.settings} settings, ${result.counts.media} media, ${result.counts.savedSearches} saved searches`
        : `Already imported (digest ${result.digest})`
      );

      exitCode = 0;
    } else if (command === 'export-json') {
      // Export Postgres data to JSON
      const exportOutputDir = outputPath ?? defaultExportOutputDir();
      const result = await exportPostgresToJson({
        pool,
        outputDir: exportOutputDir,
        defaultSettings: () => ({
          libraries: [
            { id: 'default', name: 'Library', path: paths.dataRoot, enabled: true, startExpanded: true },
          ],
          tagCatalog: [],
          tagAliases: {},
        }),
        defaultLibraryPath: paths.dataRoot,
      });

      console.log(`Exported: ${result.counts.settings} settings, ${result.counts.media} media, ${result.counts.savedSearches} saved searches`);
      console.log(`Output directory: ${result.outputDir}`);
      console.log(`Digest: ${result.digest}`);

      exitCode = 0;
    } else {
      // Should never reach here
      exitCode = 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${command === 'import-json' ? 'Import' : 'Export'} failed: ${msg}`);
    exitCode = 1;
  } finally {
    await pool.end();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
