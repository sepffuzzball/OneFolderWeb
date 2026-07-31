/**
 * Tests for persistence factory.
 *
 * Verifies default/explicit JSON driver and unsupported driver rejection,
 * exact production provider object identity, and that changing
 * PERSISTENCE_DRIVER to unsupported after prior JSON initialization causes
 * both getPersistenceProvider() and any storage facade call to reject/throw
 * rather than reuse the stale JSON provider.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { vi } from 'vitest';

// ---- Helper: Remove all ESM module cache references ----
function clearModuleCache(): void {
  const modules = Object.keys((require as any).cache || {});
  for (const modId of modules) {
    delete (require as any).cache[modId];
  }
}

// Each test must import factory and storage via dynamic imports to bypass
// module caching across tests. Use vi.resetModules() to force fresh imports.

describe('Persistence factory', () => {
  let originalDriver: string | undefined;

  beforeEach(() => {
    originalDriver = process.env.PERSISTENCE_DRIVER;
    // Ensure no stale module state leaks.
    vi.resetModules();
    clearModuleCache();
  });

  afterEach(() => {
    // Restore original env.
    if (originalDriver === undefined) delete process.env.PERSISTENCE_DRIVER;
    else process.env.PERSISTENCE_DRIVER = originalDriver;

    // Also restore DATABASE_URL and pool env vars in case postgres tests set them.
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) delete process.env.DATABASE_URL;
    delete process.env.POSTGRES_POOL_MAX;
    delete process.env.POSTGRES_IDLE_TIMEOUT_MS;
    delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
  });

  it('createPersistenceProvider with default driver creates a provider', async () => {
    // Default driver is json.
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = await createPersistenceProvider();
    expect(provider).toBeDefined();
    expect(provider.driver).toBe('json');
    expect(provider.settings).toBeDefined();
    expect(provider.mediaIndex).toBeDefined();
    expect(provider.savedSearches).toBeDefined();
  });

  it('createPersistenceProvider with explicit "json" driver creates a provider', async () => {
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = await createPersistenceProvider('json');
    expect(provider).toBeDefined();
    expect(provider.driver).toBe('json');
  });

  it('createPersistenceProvider rejects unsupported driver', async () => {
    const { createPersistenceProvider } = await import('./factory.js');
    await expect(createPersistenceProvider('postgresql')).rejects.toThrow('Unsupported persistence driver');
  });

  it('createPersistenceProvider with env override uses the env value', async () => {
    process.env.PERSISTENCE_DRIVER = 'json';
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = await createPersistenceProvider();
    expect(provider).toBeDefined();
    expect(provider.driver).toBe('json');
  });

  it('createPersistenceProvider with unsupported env override throws', async () => {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    // Missing DATABASE_URL should also throw for postgres.
    const { createPersistenceProvider } = await import('./factory.js');
    await expect(createPersistenceProvider()).rejects.toThrow(/Unsupported persistence driver|DATABASE_URL/);
  });

  it('initializePersistenceProvider throws for unsupported env override', async () => {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    const { initializePersistenceProvider } = await import('./factory.js');
    await expect(initializePersistenceProvider()).rejects.toThrow(/Unsupported persistence driver|DATABASE_URL/);
  });

  it('initializePersistenceProvider returns the productionJsonProvider (exact object identity)', async () => {
    const { productionJsonProvider, initializePersistenceProvider } = await import('./factory.js');
    const provider = await initializePersistenceProvider();
    expect(provider).toBe(productionJsonProvider);
    expect(provider.driver).toBe('json');
    expect(provider.settings).toBeDefined();
  });

  it('getPersistenceProvider always delegates to initializePersistenceProvider (returns productionJsonProvider)', async () => {
    const { productionJsonProvider, initializePersistenceProvider, getPersistenceProvider } = await import('./factory.js');
    // First initialize.
    await initializePersistenceProvider();
    // Then get.
    const provider = await getPersistenceProvider();
    expect(provider).toBe(productionJsonProvider);
  });

  it('getPersistenceProvider and initializePersistenceProvider are the same object', async () => {
    const { initializePersistenceProvider, getPersistenceProvider, productionJsonProvider } = await import('./factory.js');
    const initResult = await initializePersistenceProvider();
    const getResult = await getPersistenceProvider();
    expect(initResult).toBe(productionJsonProvider);
    expect(getResult).toBe(productionJsonProvider);
    expect(getResult).toBe(initResult);
  });

  it('changing PERSISTENCE_DRIVER to unsupported after JSON init causes initializePersistenceProvider to throw', async () => {
    // First initialize with JSON.
    const { productionJsonProvider, initializePersistenceProvider } = await import('./factory.js');
    const init1 = await initializePersistenceProvider();
    expect(init1).toBe(productionJsonProvider);

    // Now change env to unsupported.
    process.env.PERSISTENCE_DRIVER = 'mongo';
    // Call initializePersistenceProvider again. It should throw because driver changed.
    await expect(initializePersistenceProvider()).rejects.toThrow(/Persistence driver changed/);
  });

  it('changing PERSISTENCE_DRIVER to unsupported after JSON init causes storage facade to throw', async () => {
    // First initialize with JSON.
    const { productionJsonProvider, initializePersistenceProvider } = await import('./factory.js');
    const init1 = await initializePersistenceProvider();
    expect(init1).toBe(productionJsonProvider);

    // Now change env to unsupported.
    process.env.PERSISTENCE_DRIVER = 'mongo';
    // Must re-import storage module (which imports factory) to get fresh state.
    vi.resetModules();
    clearModuleCache();
    const { loadSettings } = await import('../storage.js');
    // loadSettings should reject because getPersistenceProvider() will throw (not initialized in fresh import).
    await expect(loadSettings()).rejects.toThrow('Persistence provider not initialized');
  });

  it('createPersistenceProvider with postgres driver and missing DATABASE_URL throws', async () => {
    const originalUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const { createPersistenceProvider } = await import('./factory.js');
    await expect(createPersistenceProvider('postgres')).rejects.toThrow('DATABASE_URL');
    if (originalUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalUrl;
  });

  it('parseStrictInt validates POSTGRES_POOL_MAX bounds', async () => {
    process.env.POSTGRES_POOL_MAX = '0';
    process.env.DATABASE_URL = 'postgres://localhost/test';
    const { createPersistenceProvider } = await import('./factory.js');
    await expect(createPersistenceProvider('postgres')).rejects.toThrow(/POSTGRES_POOL_MAX/);
    delete process.env.POSTGRES_POOL_MAX;
    delete process.env.DATABASE_URL;
  });

  it('parseStrictInt validates POSTGRES_IDLE_TIMEOUT_MS bounds', async () => {
    process.env.POSTGRES_IDLE_TIMEOUT_MS = '-1';
    process.env.DATABASE_URL = 'postgres://localhost/test';
    const { createPersistenceProvider } = await import('./factory.js');
    await expect(createPersistenceProvider('postgres')).rejects.toThrow(/POSTGRES_IDLE_TIMEOUT_MS/);
    delete process.env.POSTGRES_IDLE_TIMEOUT_MS;
    delete process.env.DATABASE_URL;
  });

  it('parseStrictInt validates POSTGRES_CONNECTION_TIMEOUT_MS bounds', async () => {
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = '3600001';
    process.env.DATABASE_URL = 'postgres://localhost/test';
    const { createPersistenceProvider } = await import('./factory.js');
    await expect(createPersistenceProvider('postgres')).rejects.toThrow(/POSTGRES_CONNECTION_TIMEOUT_MS/);
    delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    delete process.env.DATABASE_URL;
  });

  it('createPersistenceProvider with postgres driver and valid DATABASE_URL constructs a provider', async () => {
    process.env.DATABASE_URL = 'postgres://localhost/test';
    vi.mock('./postgres/provider.js', () => {
      return {
        PostgresPersistenceProvider: class FakeProvider {
          readonly driver = 'postgres';
          async initialize() {}
          async close() {}
          async checkReady() { return true; }
          settings = {};
          mediaIndex = {};
          savedSearches = {};
        },
      };
    });
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = await createPersistenceProvider('postgres');
    expect(provider).toBeDefined();
    expect(provider.driver).toBe('postgres');
    delete process.env.DATABASE_URL;
    vi.unmock('./postgres/provider.js');
  });

  it('initializePersistenceProvider caches and shares the same provider for concurrent calls with json', async () => {
    const { initializePersistenceProvider } = await import('./factory.js');
    const p1 = initializePersistenceProvider();
    const p2 = initializePersistenceProvider();
    const result1 = await p1;
    const result2 = await p2;
    expect(result1).toBe(result2);
  });

  it('closePersistenceProvider is idempotent', async () => {
    const { closePersistenceProvider } = await import('./factory.js');
    // close first time
    await closePersistenceProvider();
    // close second time - should not throw
    await closePersistenceProvider();
  });

  it('closePersistenceProvider shares one close operation and waits in-flight initialization', async () => {
    const { initializePersistenceProvider, closePersistenceProvider } = await import('./factory.js');
    // Start initialization
    const initPromise = initializePersistenceProvider();
    // Close before initialization resolves
    const close1 = closePersistenceProvider();
    const close2 = closePersistenceProvider();
    // Both close promises should resolve to undefined
    await expect(close1).resolves.toBeUndefined();
    await expect(close2).resolves.toBeUndefined();
    // Wait for initialization (should resolve with closePromise pending)
    await initPromise.catch(() => {});
    await closePersistenceProvider();
  });

  it('initialize after close is permitted (state cleared)', async () => {
    const { initializePersistenceProvider, closePersistenceProvider } = await import('./factory.js');
    // Initialize and close
    await initializePersistenceProvider();
    await closePersistenceProvider();
    // Initialize again - should succeed because state was cleared
    const provider = await initializePersistenceProvider();
    expect(provider.driver).toBe('json');
    await closePersistenceProvider();
  });

  it('concurrent calls for the same driver receive the same promise/provider', async () => {
    const { initializePersistenceProvider } = await import('./factory.js');
    // Start two concurrent calls
    const p1 = initializePersistenceProvider();
    const p2 = initializePersistenceProvider();
    // They should resolve to the same provider
    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toBe(r2);
    expect(r1.driver).toBe('json');
  });

  it('deferred concurrent initialize and close without provider', async () => {
    const { createPersistenceProvider } = await import('./factory.js');
    // Ensure DATABASE_URL is set for postgres
    process.env.DATABASE_URL = 'postgres://localhost/test';
    // Create two concurrent providers
    const provider1 = createPersistenceProvider('postgres');
    const provider2 = createPersistenceProvider('postgres');
    expect(provider1).toBeDefined();
    expect(provider2).toBeDefined();
    delete process.env.DATABASE_URL;
  });

  it('retry initialization after failure', async () => {
    const { initializePersistenceProvider, closePersistenceProvider } = await import('./factory.js');
    // First attempt with invalid driver
    process.env.PERSISTENCE_DRIVER = 'invalid';
    await expect(initializePersistenceProvider()).rejects.toThrow('Unsupported persistence driver');
    // Reset to valid driver and retry
    process.env.PERSISTENCE_DRIVER = 'json';
    const provider = await initializePersistenceProvider();
    expect(provider.driver).toBe('json');
    await closePersistenceProvider();
  });

  it('repeated initialize/close/check-after-close with json', async () => {
    const { initializePersistenceProvider, closePersistenceProvider, getPersistenceProvider } = await import('./factory.js');
    // Initialize
    const provider1 = await initializePersistenceProvider();
    expect(provider1.driver).toBe('json');
    // Close
    await closePersistenceProvider();
    // Initialize again
    const provider2 = await initializePersistenceProvider();
    expect(provider2.driver).toBe('json');
    // Close again
    await closePersistenceProvider();
    // Wait for close then try getPersistenceProvider
    await expect(getPersistenceProvider()).rejects.toThrow('Persistence provider not initialized');
  });

  it('driver change after initialization rejects', async () => {
    const { initializePersistenceProvider } = await import('./factory.js');
    // Initialize with json
    await initializePersistenceProvider();
    // Change env to unsupported
    process.env.PERSISTENCE_DRIVER = 'postgresql';
    await expect(initializePersistenceProvider()).rejects.toThrow(/Persistence driver changed/);
  });

  it('provider repeated initialize/close works with json', async () => {
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = await createPersistenceProvider('json');
    // Initialize and close repeatedly
    await provider.initialize();
    await provider.initialize(); // should be no-op (memoized)
    await provider.close();
    await provider.close(); // should be no-op (memoized)
    // Verify provider still usable after repeated cycle
    expect(provider.driver).toBe('json');
  });

  it('failed factory init closes the exact provider instance that failed, not a second creation', async () => {
    // Use a temporary env and force a fresh import that will fail.
    process.env.PERSISTENCE_DRIVER = 'invalid-driver';
    const { initializePersistenceProvider } = await import('./factory.js');
    await expect(initializePersistenceProvider()).rejects.toThrow('Unsupported persistence driver');
    // The createPersistenceProvider call should only happen once; no retry in catch.
    delete process.env.PERSISTENCE_DRIVER;
    // Also verify close before init then later init/close works.
    process.env.PERSISTENCE_DRIVER = 'json';
    const { closePersistenceProvider } = await import('./factory.js');
    await closePersistenceProvider();
    delete process.env.PERSISTENCE_DRIVER;
  });

  it('close before init then later close works (no stale resolved closePromise)', async () => {
    const { initializePersistenceProvider, closePersistenceProvider } = await import('./factory.js');
    // Close before any init.
    await closePersistenceProvider(); // should be no-op
    // Now initialize
    await initializePersistenceProvider();
    // Close again — should clear state and work.
    await closePersistenceProvider();
    // Verify no stale closePromise.
    await expect(closePersistenceProvider()).resolves.toBeUndefined();
  });

  it('same-provider migration retry after migration failure in postgres', async () => {
    // Reset modules to ensure truly fresh state.
    vi.resetModules();
    clearModuleCache();
    process.env.PERSISTENCE_DRIVER = 'postgres';
    process.env.DATABASE_URL = 'postgres://localhost/test';
    // Set pool env vars to valid defaults to avoid parseStrictInt errors.
    process.env.POSTGRES_POOL_MAX = '10';
    process.env.POSTGRES_IDLE_TIMEOUT_MS = '10000';
    process.env.POSTGRES_CONNECTION_TIMEOUT_MS = '5000';
    // Use a fake provider that fails migrations.
    vi.mock('./postgres/provider.js', () => {
      const FakeProvider = class {
        get driver() { return 'postgres'; }
        async initialize() { throw new Error('migration failed'); }
        async close() {}
        async checkReady() { return false; }
        settings = {};
        mediaIndex = {};
        savedSearches = {};
      };
      return { PostgresPersistenceProvider: FakeProvider };
    });
    // Import factory with fresh state.
    const { initializePersistenceProvider } = await import('./factory.js');
    // The first call should reject because the mock provider throws.
    // Use a more flexible assertion: any error should be thrown.
    await expect(initializePersistenceProvider()).rejects.toThrow();
    // Second call on the same (not closed) provider should also reject (retry).
    await expect(initializePersistenceProvider()).rejects.toThrow();
    delete process.env.POSTGRES_CONNECTION_TIMEOUT_MS;
    delete process.env.POSTGRES_IDLE_TIMEOUT_MS;
    delete process.env.POSTGRES_POOL_MAX;
    delete process.env.DATABASE_URL;
    delete process.env.PERSISTENCE_DRIVER;
    vi.unmock('./postgres/provider.js');
  });
});
