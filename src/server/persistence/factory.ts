/**
 * Persistence provider factory.
 *
 * Creates a PersistenceProvider instance with the specified driver.
 * Only `json` and `postgres` are accepted; unsupported drivers throw a clear
 * startup/configuration error.
 *
 * Constructors do no async work, so factory calls are synchronous.
 */

import { paths, runtimeConfig } from '../config.js';
import path from 'node:path';
import type { PersistenceProvider } from './repositories.js';
import {
  JsonSettingsRepository,
  JsonMediaIndexRepository,
  JsonSavedSearchRepository,
  settingsRepository,
  mediaIndexRepository,
  savedSearchesRepository,
} from './json.js';

/** Default pool env variables and their defaults/ranges. */
const POOL_MAX_DEFAULT = 10;
const POOL_MAX_RANGE = [1, 100];
const IDLE_TIMEOUT_DEFAULT = 10000;
const IDLE_TIMEOUT_RANGE = [0, 3600000];
const CONN_TIMEOUT_DEFAULT = 5000;
const CONN_TIMEOUT_RANGE = [1, 3600000];

/**
 * Parse a strict base-10 integer environment variable value.
 */
function parseStrictInt(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed) || String(parsed) !== value) {
    // Error only on the variable name, never on the value/URL itself.
    throw new Error(`Invalid ${name}: must be a strict base-10 integer`);
  }
  if (parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * Default driver name from environment, falling back to `json`.
 */
function defaultDriver(): string {
  return process.env.PERSISTENCE_DRIVER ?? 'json';
}

/**
 * Options for createPersistenceProvider.
 */
export type PersistenceProviderOptions = {
  settingsDir?: string;
  backupDir?: string;
  backupRetentionDays?: number;
  backupIntervalHours?: number;
};

/**
 * The production singleton provider object containing all three repository
 * singletons for JSON. This object identity is used by every default call to
 * createPersistenceProvider() and must be the same object across all calls.
 */
export const productionJsonProvider: PersistenceProvider = {
  driver: 'json',
  settings: settingsRepository,
  mediaIndex: mediaIndexRepository,
  savedSearches: savedSearchesRepository,
  async initialize() {},
  async close() {},
  async checkReady() { return true; },
};

/**
 * Cache the selected driver name to detect changes or conflicts.
 * Also caches the initialization promise and the resolved provider.
 */
let selectedDriver: string | undefined;
let initPromise: Promise<PersistenceProvider> | undefined;
let initializedProvider: PersistenceProvider | undefined;

/**
 * Create a PersistenceProvider with all three repositories.
 *
 * The driver parameter defaults from PERSISTENCE_DRIVER env or `json`.
 * Only `json` and `postgres` are accepted; unsupported drivers throw a clear error.
 */
export async function createPersistenceProvider(
  driver?: string,
  options?: PersistenceProviderOptions,
): Promise<PersistenceProvider> {
  const actualDriver = driver ?? defaultDriver();

  if (actualDriver === 'json') {
    // Production singleton: if options are empty or use defaults, return existing singletons.
    const settingsDir = options?.settingsDir;
    const backupDir = options?.backupDir;
    const backupRetentionDays =
      options?.backupRetentionDays;
    const backupIntervalHours =
      options?.backupIntervalHours;

    const isProduction =
      (settingsDir === undefined || settingsDir === paths.settingsDir) &&
      (backupDir === undefined || backupDir === paths.backupDir) &&
      (backupRetentionDays === undefined ||
        backupRetentionDays === runtimeConfig.backupRetentionDays) &&
      (backupIntervalHours === undefined ||
        backupIntervalHours === runtimeConfig.backupIntervalHours);

    if (isProduction) {
      return productionJsonProvider;
    }

    // Isolated factory creates new instances.
    const finalSettingsDir = settingsDir ?? paths.settingsDir;
    const finalBackupDir = backupDir ?? paths.backupDir;
    const finalBackupRetentionDays =
      backupRetentionDays ?? runtimeConfig.backupRetentionDays;
    const finalBackupIntervalHours =
      backupIntervalHours ?? runtimeConfig.backupIntervalHours;

    const settings = new JsonSettingsRepository({
      primaryPath: path.join(finalSettingsDir, 'settings.json'),
      backupDir: finalBackupDir,
      backupRetentionDays: finalBackupRetentionDays,
      backupIntervalHours: finalBackupIntervalHours,
      defaultSettings: () => ({
        libraries: [
          { id: 'default', name: 'Library', path: paths.dataRoot, enabled: true, startExpanded: true },
        ],
        tagCatalog: [],
        tagAliases: {},
      }),
      defaultLibraryPath: paths.dataRoot,
    });

    const mediaIndex = new JsonMediaIndexRepository({
      primaryPath: path.join(finalSettingsDir, 'index.json'),
      backupDir: finalBackupDir,
      backupRetentionDays: finalBackupRetentionDays,
      backupIntervalHours: finalBackupIntervalHours,
      defaultIndex: () => ({
        version: 1,
        generatedAt: new Date(0).toISOString(),
        files: [],
      }),
    });

    const savedSearches = new JsonSavedSearchRepository({
      primaryPath: path.join(finalSettingsDir, 'saved-searches.json'),
    });

    return { driver: 'json', settings, mediaIndex, savedSearches, async initialize() {}, async close() {}, async checkReady() { return true; } };
  }

  if (actualDriver === 'postgres') {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required for postgres driver');
    }

    // Parse environment variables for pool config.
    const poolMax = parseStrictInt('POSTGRES_POOL_MAX', process.env.POSTGRES_POOL_MAX, POOL_MAX_DEFAULT, 1, 100);
    const poolIdleTimeout = parseStrictInt('POSTGRES_IDLE_TIMEOUT_MS', process.env.POSTGRES_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_DEFAULT, 0, 3600000);
    const poolConnectionTimeout = parseStrictInt('POSTGRES_CONNECTION_TIMEOUT_MS', process.env.POSTGRES_CONNECTION_TIMEOUT_MS, CONN_TIMEOUT_DEFAULT, 1, 3600000);

    // Dynamically import the postgres provider module.
    const { PostgresPersistenceProvider } = await import('./postgres/provider.js');

    return new PostgresPersistenceProvider({
      DATABASE_URL,
      poolMax,
      poolIdleTimeout,
      poolConnectionTimeout,
    });
  }

  throw new Error(
    `Unsupported persistence driver: "${actualDriver}". Only "json" or "postgres" are accepted.`,
  );
}

/**
 * Validate the PERSISTENCE_DRIVER environment variable on every call and
 * return the initialized provider. This rejects unsupported drivers
 * before any app startup (including listen). Call this at application
 * initialization. Every call reads and validates the current environment
 * value.
 *
 * This is now async because Postgres initialization requires async work.
 * The function is memoized: only one initialization promise is cached,
 * and concurrent callers receive the exact same promise/provider.
 * Subsequent calls validate the driver matches the cached driver; a driver
 * change after initialization is rejected.
 *
 * If create or initialize fails, the partially created provider is closed,
 * the cached state is cleared (only if the failed attempt was the current
 * cached one), and the caller is allowed to retry initialization.
 */
export async function initializePersistenceProvider(): Promise<PersistenceProvider> {
  const driver = defaultDriver();

  // If cached and driver matches, return the cached promise.
  if (selectedDriver && initializedProvider) {
    if (initializedProvider.driver !== driver) {
      throw new Error(
        `Persistence driver changed from "${initializedProvider.driver}" to "${driver}". Only "${initializedProvider.driver}" is allowed after initialization.`,
      );
    }
    return initPromise!;
  }

  // Not initialized or driver doesn't match; validate driver first.
  if (driver !== 'json' && driver !== 'postgres') {
    throw new Error(
      `Unsupported persistence driver: "${driver}". Only "json" or "postgres" are accepted.`,
    );
  }

  // If we're already in the middle of initializing (selectedDriver is set but
  // initPromise is not yet resolved), return the same pending promise.
  if (selectedDriver && driver === selectedDriver && initPromise) {
    return initPromise;
  }

  // Record the selected driver and begin initialization.
  selectedDriver = driver;

  // Declare provider outside the try so the catch can close the exact instance that failed.
  // Use ! to appease TS; the assignment is safe.
  let provider!: PersistenceProvider;

  initPromise = (async () => {
    try {
      provider = await createPersistenceProvider(driver);
      await provider.initialize();
      initializedProvider = provider;
    } catch (err) {
      // On failure, close the exactly this provider (the one that failed initialize).
      // NEVER call createPersistenceProvider again in catch.
      if (provider) {
        try {
          await provider.close().catch(() => { /* ignore close errors */ });
        } catch {
          // provider.close may itself fail; nothing further to do
        }
      }
      // Clear the cached state only if this was the current attempt.
      if (selectedDriver === driver) {
        selectedDriver = undefined;
        initPromise = undefined;
        initializedProvider = undefined;
      }
      throw err;
    }
    return provider;
  })();

  return initPromise;
}

/**
 * Get the exact initialized persistence provider. Awaits the cached initialization
 * promise. Throws if no provider has been initialized.
 */
export async function getPersistenceProvider(): Promise<PersistenceProvider> {
  if (!initializedProvider || !initPromise) {
    throw new Error('Persistence provider not initialized. Call initializePersistenceProvider first.');
  }
  return initPromise;
}

/**
 * Ownership slot: closePromise is set only when we "own" the close operation.
 * An early close with no provider cannot leave a stale resolved closePromise.
 */
let closePromise: Promise<void> | undefined;

/**
 * Close the current persistence provider idempotently. Uses a local operation
 * promise and outer finally that clears closePromise only when it still owns
 * the slot.
 *
 * 1. Waits current init (if any); ignores its failure.
 * 2. Closes the resolved exact provider once.
 * 3. Clears selected/init/provider state.
 */
export async function closePersistenceProvider(): Promise<void> {
  // If we already own the close slot, return it.
  if (closePromise) {
    return closePromise;
  }

  // Build the local close operation promise.
  const localOp = (async () => {
    // Wait for any in-flight initialization to complete, ignoring its failure.
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // initialization may have failed; ignore the error
      }
    }

    // Close the provider if it exists, propagating its error.
    if (initializedProvider) {
      await initializedProvider.close();
    }
  })();

  // Set closePromise to the local operation; if it resolves successfully,
  // we still "own" the close slot; the outer finally clears it only if
  // we still own it.
  closePromise = localOp;

  try {
    await localOp;
  } finally {
    // Clear lifecycle state only if we still own the close slot
    if (closePromise === localOp) {
      selectedDriver = undefined;
      initPromise = undefined;
      initializedProvider = undefined;
      closePromise = undefined;
    }
  }

  // Return the (now potentially undefined) closePromise so callers
  // still await safely.
  return closePromise!;
}
