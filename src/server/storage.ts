/**
 * Compatibility facade for settings and media index persistence.
 *
 * Keeps exact signatures of loadSettings, saveSettings, loadIndex, saveIndex
 * from the original storage.ts, while adding updateSettings and delegating
 * all operations to the new persistence layer via the persistenceProvider.
 *
 * Also adds facade functions for saved searches.
 */

import { getPersistenceProvider } from './persistence/factory.js';
import type { AppSettings, MediaItem, SavedSearch, SavedSearchInput } from '../shared/types.js';
import type { MediaIndex } from './persistence/repositories.js';

export type { MediaIndex };

async function getProvider(): Promise<Awaited<ReturnType<typeof getPersistenceProvider>>> {
  return getPersistenceProvider();
}

export async function loadSettings(): Promise<AppSettings> {
  return (await getProvider()).settings.load();
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return (await getProvider()).settings.save(settings);
}

export async function updateSettings(
  mutator: (current: Readonly<AppSettings>) => AppSettings,
): Promise<AppSettings> {
  return (await getProvider()).settings.update(mutator);
}

export async function loadIndex(): Promise<MediaIndex> {
  return (await getProvider()).mediaIndex.load();
}

export async function saveIndex(files: MediaItem[]): Promise<MediaIndex> {
  return (await getProvider()).mediaIndex.save(files as readonly MediaItem[]);
}

// ---- Saved search facades ---------------------------------------------------

export async function listSavedSearches(): Promise<SavedSearch[]> {
  return (await getProvider()).savedSearches.list();
}

export async function getSavedSearch(id: string): Promise<SavedSearch | undefined> {
  return (await getProvider()).savedSearches.get(id);
}

export async function createSavedSearch(input: SavedSearchInput): Promise<SavedSearch> {
  return (await getProvider()).savedSearches.create(input);
}

export async function updateSavedSearch(id: string, input: SavedSearchInput): Promise<SavedSearch | undefined> {
  return (await getProvider()).savedSearches.update(id, input);
}

export async function deleteSavedSearch(id: string): Promise<boolean> {
  return (await getProvider()).savedSearches.delete(id);
}
