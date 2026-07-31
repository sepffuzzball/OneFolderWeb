/**
 * PostgresPersistenceProvider: a production PersistenceProvider implementation
 * that owns one Pool, constructs all three Postgres repositories with current
 * defaults/paths, runs runPostgresMigrations once in initialize(), SELECT 1 in
 * checkReady(), pool.end once in close().
 *
 * Pool errors log a generic credential-free message only.
 */

import pg from 'pg';
import { createPostgresPool, type Pool } from './pool.js';
import { runPostgresMigrations } from './migrations.js';
import {
  PostgresSettingsRepository,
  PostgresMediaIndexRepository,
  PostgresSavedSearchRepository,
} from './repositories.js';
import type { PersistenceProvider } from '../repositories.js';
import { paths } from '../../config.js';

/**
 * Options for constructing a PostgresPersistenceProvider.
 */
export type PostgresPersistenceProviderOptions = {
  DATABASE_URL: string;
  poolMax?: number;
  poolIdleTimeout?: number;
  poolConnectionTimeout?: number;
};

export class PostgresPersistenceProvider implements PersistenceProvider {
  readonly driver = 'postgres';
  readonly #pool: Pool;
  readonly settings: PostgresSettingsRepository;
  readonly mediaIndex: PostgresMediaIndexRepository;
  readonly savedSearches: PostgresSavedSearchRepository;
  #migrationsApplied = false;
  #initializePromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(opts: PostgresPersistenceProviderOptions) {
    this.#pool = createPostgresPool({
      DATABASE_URL: opts.DATABASE_URL,
      poolMax: opts.poolMax,
      poolIdleTimeout: opts.poolIdleTimeout,
      poolConnectionTimeout: opts.poolConnectionTimeout,
    });

    // Construct repositories with current paths/defaults.
    this.settings = new PostgresSettingsRepository({
      pool: this.#pool,
      defaults: {
        defaultSettings: () => ({
          libraries: [
            { id: 'default', name: 'Library', path: paths.dataRoot, enabled: true, startExpanded: true },
          ],
          tagCatalog: [],
          tagAliases: {},
        }),
      },
      defaultLibraryPath: paths.dataRoot,
    });

    this.mediaIndex = new PostgresMediaIndexRepository({
      pool: this.#pool,
    });

    this.savedSearches = new PostgresSavedSearchRepository({
      pool: this.#pool,
    });
  }

  async initialize(): Promise<void> {
    // If already initialized or initialization is in progress, return the memoized promise.
    if (this.#initializePromise) {
      // If the previous initialization failed with a rejected promise,
      // allow a retry on the same not-closed provider.
      try {
        await this.#initializePromise;
        return;
      } catch (err) {
        // Migration rejection: clear the promise so a retry on the same provider can run again.
        if (!this.#closed) {
          this.#initializePromise = undefined;
        }
        // Re-throw to let the caller know initialization failed.
        throw err;
      }
    }
    // If already closed, reject immediately.
    if (this.#closed) {
      throw new Error('Cannot initialize after close');
    }
    // Create a new initialize promise; if it rejects, clear it so a retry
    // on the same not-closed provider can run again.
    this.#initializePromise = (async () => {
      try {
        if (!this.#migrationsApplied) {
          await runPostgresMigrations(this.#pool);
          this.#migrationsApplied = true;
        }
        return;
      } catch (err) {
        // On migration failure, clear the promise for retry.
        if (!this.#closed) {
          this.#initializePromise = undefined;
        }
        throw err;
      }
    })();
    return this.#initializePromise;
  }

  async close(): Promise<void> {
    // Memoized: return the existing close promise if any.
    if (this.#closePromise) {
      return this.#closePromise;
    }
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    // Wait for any in-flight initialization to complete, ignoring its failure.
    if (this.#initializePromise) {
      try {
        await this.#initializePromise;
      } catch {
        // ignore initialization failure
      }
    }
    this.#closePromise = (async () => {
      await this.#pool.end();
    })();
    return this.#closePromise;
  }

  async checkReady(): Promise<boolean> {
    if (this.#closed) {
      return false;
    }
    try {
      // SELECT 1 is a simple connectivity check.
      const client = await this.#pool.connect();
      try {
        await client.query('SELECT 1');
        return true;
      } catch {
        return false;
      } finally {
        client.release();
      }
    } catch {
      return false;
    }
  }
}
