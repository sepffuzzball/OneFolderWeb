/**
 * Repository interfaces for settings and media index persistence.
 *
 * The `update` methods accept a synchronous, side-effect-free mutator callback
 * that receives a read-only snapshot of the current state and must return the
 * new state. Future database-backed implementations must provide transactional
 * semantics; the JSON file implementation provides serialized atomicity via a
 * per-key shared serial executor queue.
 */

import type { AppSettings, MediaItem } from '../../shared/types.js';

/** Exact on-disk shape for the media index. */
export type MediaIndex = {
  version: number;
  generatedAt: string;
  files: MediaItem[];
};

export interface SettingsRepository {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<AppSettings>;
  update(mutator: (current: Readonly<AppSettings>) => AppSettings): Promise<AppSettings>;
}

export interface MediaIndexRepository {
  load(): Promise<MediaIndex>;
  save(files: readonly MediaItem[]): Promise<MediaIndex>;
}
