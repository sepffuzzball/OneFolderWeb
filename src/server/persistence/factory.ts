/**
 * Persistence provider factory.
 *
 * Creates a PersistenceProvider instance with the specified driver.
 * Only `json` is accepted currently; unsupported drivers throw a clear
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
 * singletons. This object identity is used by every default call to
 * createPersistenceProvider() and must be the same object across all calls.
 */
export const productionJsonProvider: PersistenceProvider = {
  settings: settingsRepository,
  mediaIndex: mediaIndexRepository,
  savedSearches: savedSearchesRepository,
};

/**
 * Create a PersistenceProvider with all three repositories.
 *
 * The driver parameter defaults from PERSISTENCE_DRIVER env or `json`.
 * Only `json` is accepted; unsupported drivers throw a clear error.
 */
export function createPersistenceProvider(
  driver?: string,
  options?: PersistenceProviderOptions,
): PersistenceProvider {
  const actualDriver = driver ?? defaultDriver();

  if (actualDriver !== 'json') {
    throw new Error(
      `Unsupported persistence driver: "${actualDriver}". Only "json" is accepted.`,
    );
  }

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

  return { settings, mediaIndex, savedSearches };
}

/**
 * Validate the PERSISTENCE_DRIVER environment variable on every call and
 * return the production JSON provider. This rejects unsupported drivers
 * before any app startup (including listen). Call this at application
 * initialization. Every call reads and validates the current environment
 * value; it never returns a cached object before driver validation.
 */
export function initializePersistenceProvider(): PersistenceProvider {
  const driver = defaultDriver();

  if (driver !== 'json') {
    throw new Error(
      `Unsupported persistence driver: "${driver}". Only "json" is accepted.`,
    );
  }
  return productionJsonProvider;
}

/**
 * Always delegates to initializePersistenceProvider(). This ensures that
 * any call after a driver environment change is validated, not using a
 * stale cached provider.
 */
export function getPersistenceProvider(): PersistenceProvider {
  return initializePersistenceProvider();
}
