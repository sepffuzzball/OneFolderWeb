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
  });

  it('createPersistenceProvider with default driver creates a provider', async () => {
    // Default driver is json.
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = createPersistenceProvider();
    expect(provider).toBeDefined();
    expect(provider.settings).toBeDefined();
    expect(provider.mediaIndex).toBeDefined();
    expect(provider.savedSearches).toBeDefined();
  });

  it('createPersistenceProvider with explicit "json" driver creates a provider', async () => {
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = createPersistenceProvider('json');
    expect(provider).toBeDefined();
  });

  it('createPersistenceProvider rejects unsupported driver', async () => {
    const { createPersistenceProvider } = await import('./factory.js');
    expect(() => createPersistenceProvider('postgresql')).toThrow('Unsupported persistence driver');
  });

  it('createPersistenceProvider with env override uses the env value', async () => {
    process.env.PERSISTENCE_DRIVER = 'json';
    const { createPersistenceProvider } = await import('./factory.js');
    const provider = createPersistenceProvider();
    expect(provider).toBeDefined();
  });

  it('createPersistenceProvider with unsupported env override throws', async () => {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    const { createPersistenceProvider } = await import('./factory.js');
    expect(() => createPersistenceProvider()).toThrow('Unsupported persistence driver');
  });

  it('initializePersistenceProvider throws for unsupported env override', async () => {
    process.env.PERSISTENCE_DRIVER = 'postgres';
    const { initializePersistenceProvider } = await import('./factory.js');
    expect(() => initializePersistenceProvider()).toThrow('Unsupported persistence driver');
  });

  it('initializePersistenceProvider returns the productionJsonProvider (exact object identity)', async () => {
    const { productionJsonProvider, initializePersistenceProvider } = await import('./factory.js');
    const provider = initializePersistenceProvider();
    expect(provider).toBe(productionJsonProvider);
    expect(provider.settings).toBeDefined();
  });

  it('getPersistenceProvider always delegates to initializePersistenceProvider (returns productionJsonProvider)', async () => {
    const { productionJsonProvider, getPersistenceProvider } = await import('./factory.js');
    // With clean env (json default), getPersistenceProvider should return the same production provider.
    expect(getPersistenceProvider()).toBe(productionJsonProvider);
  });

  it('getPersistenceProvider and initializePersistenceProvider are the same object', async () => {
    const { initializePersistenceProvider, getPersistenceProvider, productionJsonProvider } = await import('./factory.js');
    const initResult = initializePersistenceProvider();
    const getResult = getPersistenceProvider();
    expect(initResult).toBe(productionJsonProvider);
    expect(getResult).toBe(productionJsonProvider);
    expect(getResult).toBe(initResult);
  });

  it('changing PERSISTENCE_DRIVER to unsupported after JSON init causes getPersistenceProvider to throw', async () => {
    // First initialize with JSON.
    const { productionJsonProvider, initializePersistenceProvider, getPersistenceProvider } = await import('./factory.js');
    const init1 = initializePersistenceProvider();
    expect(init1).toBe(productionJsonProvider);

    // Now change env to unsupported.
    process.env.PERSISTENCE_DRIVER = 'mongo';
    // Must re-import to get fresh module with updated env.
    vi.resetModules();
    clearModuleCache();
    const { getPersistenceProvider: getFresh } = await import('./factory.js');
    // getPersistenceProvider should now throw because the driver is unsupported.
    expect(() => getFresh()).toThrow('Unsupported persistence driver');
  });

  it('changing PERSISTENCE_DRIVER to unsupported after JSON init causes storage facade to throw', async () => {
    // First initialize with JSON.
    const { productionJsonProvider, initializePersistenceProvider } = await import('./factory.js');
    const init1 = initializePersistenceProvider();
    expect(init1).toBe(productionJsonProvider);

    // Now change env to unsupported.
    process.env.PERSISTENCE_DRIVER = 'mongo';
    // Must re-import storage module (which imports factory) to get fresh state.
    vi.resetModules();
    clearModuleCache();
    const { loadSettings } = await import('../storage.js');
    // loadSettings should reject because getPersistenceProvider() will throw.
    await expect(loadSettings()).rejects.toThrow('Unsupported persistence driver');
  });
});
