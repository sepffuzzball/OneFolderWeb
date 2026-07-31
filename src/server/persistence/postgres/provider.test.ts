/**
 * Tests for PostgresPersistenceProvider.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock pool module before importing provider.
vi.mock('./pool.js', () => {
  const createPostgresPoolMock = vi.fn(() => ({
    connect: vi.fn(),
    end: vi.fn(),
    query: vi.fn(),
    on: vi.fn(),
  }));
  return {
    createPostgresPool: createPostgresPoolMock,
    DEFAULT_POOL_MAX: 10,
    DEFAULT_POOL_IDLE_TIMEOUT: 30000,
    DEFAULT_POOL_CONNECTION_TIMEOUT: 5000,
    // Satisfy TypeScript imports of these constants.
    __esModule: true,
  };
});

// Mock migrations module.
vi.mock('./migrations.js', () => {
  const runPostgresMigrationsMock = vi.fn().mockResolvedValue(1);
  return {
    runPostgresMigrations: runPostgresMigrationsMock,
    POSTGRES_MIGRATIONS: [],
    __esModule: true,
  };
});

import { PostgresPersistenceProvider } from './provider.js';
import { createPostgresPool } from './pool.js';
import { runPostgresMigrations } from './migrations.js';

describe('PostgresPersistenceProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure the mock pool has a proper connect/end implementation.
    (createPostgresPool as ReturnType<typeof vi.fn>).mockClear();
    (createPostgresPool as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      connect: vi.fn(),
      end: vi.fn(),
      query: vi.fn(),
      on: vi.fn(),
    }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sets driver="postgres" and constructs all three repositories', () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    expect(provider.driver).toBe('postgres');
    expect(provider.settings).toBeDefined();
    expect(provider.mediaIndex).toBeDefined();
    expect(provider.savedSearches).toBeDefined();
  });

  it('initialize runs runPostgresMigrations once', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    // First call
    await provider.initialize();
    expect(runPostgresMigrations).toHaveBeenCalledTimes(1);
    // Second call should skip (already applied)
    await provider.initialize();
    expect(runPostgresMigrations).toHaveBeenCalledTimes(1);
  });

  it('checkReady returns true when SELECT 1 succeeds', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    // The provider's internal pool is the first call to createPostgresPool.
    // Access it via the mock's last call result.
    const pool = (createPostgresPool as ReturnType<typeof vi.fn>).mock.results[0].value;
    // Make connect return a client that can query.
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [1] }),
      release: vi.fn(),
    });
    const ready = await provider.checkReady();
    expect(ready).toBe(true);
  });

  it('checkReady returns false when connection fails', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    const pool = (createPostgresPool as ReturnType<typeof vi.fn>).mock.results[0].value;
    (pool.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection error'));
    const ready = await provider.checkReady();
    expect(ready).toBe(false);
  });

  it('close() ends the pool', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    const pool = (createPostgresPool as ReturnType<typeof vi.fn>).mock.results[0].value;
    await provider.close();
    expect(pool.end).toHaveBeenCalled();
  });

  it('close() is memoized and idempotent', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    const pool = (createPostgresPool as ReturnType<typeof vi.fn>).mock.results[0].value;
    // Close first time
    await provider.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
    // Close second time - should be memoized and not call pool.end again
    await provider.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it('initialize after close throws clearly', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    await provider.close();
    await expect(provider.initialize()).rejects.toThrow('Cannot initialize after close');
  });

  it('checkReady after close returns false', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    await provider.close();
    const ready = await provider.checkReady();
    expect(ready).toBe(false);
  });

  it('client release in checkReady occurs in finally exactly once', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    const pool = (createPostgresPool as ReturnType<typeof vi.fn>).mock.results[0].value;
    const releaseFn = vi.fn();
    (pool.connect as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [1] }),
      release: releaseFn,
    });
    const ready = await provider.checkReady();
    expect(ready).toBe(true);
    expect(releaseFn).toHaveBeenCalledTimes(1);
  });

  it('initialize retry after migration failure clears previous promise', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    // Make runPostgresMigrations reject permanently.
    (runPostgresMigrations as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('migration failed'));
    // First call: should reject.
    await expect(provider.initialize()).rejects.toThrow('migration failed');
    // The initialize promise should now be cleared by the catch block.
    // Second call: the mock still rejects, but this demonstrates retry.
    await expect(provider.initialize()).rejects.toThrow('migration failed');
    // Verify migrations were called twice.
    expect(runPostgresMigrations).toHaveBeenCalledTimes(2);
  });

  it('close waits any initialization (ignoring failure) and calls pool.end once', async () => {
    const provider = new PostgresPersistenceProvider({
      DATABASE_URL: 'postgres://localhost/test',
    });
    const pool = (createPostgresPool as ReturnType<typeof vi.fn>).mock.results[0].value;
    // Make runPostgresMigrations reject.
    (runPostgresMigrations as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('migration failed'));
    // Start initialize (will reject)
    const initPromise = provider.initialize().catch(() => {});
    // Close while init is in-flight (ignores the failure)
    await provider.close();
    // pool.end should have been called once.
    expect(pool.end).toHaveBeenCalledTimes(1);
    // A second close is memoized.
    await provider.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
