/**
 * Compatibility facade for settings and media index persistence.
 *
 * Keeps exact signatures of loadSettings, saveSettings, loadIndex, saveIndex
 * from the original storage.ts, while adding updateSettings and delegating
 * all operations to the new persistence layer singletons.
 */

import type { AppSettings, MediaItem } from '../shared/types.js';
import { settingsRepository, mediaIndexRepository } from './persistence/json.js';
import type { MediaIndex } from './persistence/repositories.js';

export type { MediaIndex };

export async function loadSettings(): Promise<AppSettings> {
  return settingsRepository.load();
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return settingsRepository.save(settings);
}

export async function updateSettings(
  mutator: (current: Readonly<AppSettings>) => AppSettings,
): Promise<AppSettings> {
  return settingsRepository.update(mutator);
}

export async function loadIndex(): Promise<MediaIndex> {
  return mediaIndexRepository.load();
}

export async function saveIndex(files: MediaItem[]): Promise<MediaIndex> {
  return mediaIndexRepository.save(files as readonly MediaItem[]);
}
