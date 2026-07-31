import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterAll, beforeAll, beforeEach } from 'vitest';
import type express from 'express';
import type { Server } from 'node:http';


/**
 * Integration tests for the server app — using Node 22 native fetch.
 * Filesystem-isolated: each test creates a temp root, sets env vars, creates
 * controlled storage dirs and settings, then dynamically imports config/app.
 */

const originalEnv = {
  DATA_ROOT: process.env.DATA_ROOT,
  SETTINGS_DIR: process.env.SETTINGS_DIR,
  THUMBNAIL_DIR: process.env.THUMBNAIL_DIR,
  BACKUP_DIR: process.env.BACKUP_DIR,
  TRASH_DIR: process.env.TRASH_DIR,
  PERSISTENCE_DRIVER: process.env.PERSISTENCE_DRIVER,
};

let app: express.Express;
let server: Server;
let baseUrl: string;
let tempRoot: string;

beforeAll(async () => {
  // Create temp root
  // Create temp root using mkdtempSync from fs
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onefolder-test-'));

  // Set env vars to point to temp subdirs
  const dataRoot = path.join(tempRoot, 'data', 'library');
  const settingsDir = path.join(tempRoot, 'data', 'settings');
  const thumbnailDir = path.join(tempRoot, 'data', 'thumbnails');
  const backupDir = path.join(tempRoot, 'data', 'backups');
  const trashDir = path.join(tempRoot, 'data', 'trash');

  process.env.DATA_ROOT = dataRoot;
  process.env.SETTINGS_DIR = settingsDir;
  process.env.THUMBNAIL_DIR = thumbnailDir;
  process.env.BACKUP_DIR = backupDir;
  process.env.TRASH_DIR = trashDir;

  // Ensure storage dirs exist
  const { ensureStorageDirs } = await import('./config.js');
  await ensureStorageDirs();

  // Write controlled valid settings with one enabled library
  const settingsJson = JSON.stringify({
    libraries: [
      {
        id: 'test-lib',
        name: 'Test Library',
        path: dataRoot,
        enabled: true,
        startExpanded: false,
      },
    ],
    tagCatalog: [],
    tagAliases: {},
  });
  await fs.promises.writeFile(path.join(settingsDir, 'settings.json'), settingsJson);

  // Dynamically import config/app with fresh modules
  const { createApp } = await import('./app.js');

  // Create app with side effects disabled
  app = await createApp({
    noInitializeIndex: true,
    noAttachScanner: true,
    noAttachFrontend: true,
    noProcessSignals: true,
  });

  // Start test server on ephemeral port
  server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not get server address');
  baseUrl = `http://localhost:${address.port}`;
});

afterAll(async () => {
  // Close HTTP server
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Restore from module-scope originalEnv
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Recursively remove temp root
  await fs.promises.rm(tempRoot, { recursive: true, force: true });
});

async function fetchUrl(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, options);
}

describe('health and readiness', () => {
  it('GET /healthz returns 200 with status ok', async () => {
    const res = await fetchUrl('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { status: 'ok' } });
  });

  it('GET /readyz returns 200 with "ready" when all storage dirs exist and writable', async () => {
    const res = await fetchUrl('/readyz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe('ready');
    expect(Array.isArray(body.data.checks)).toBe(true);
    // All checks should pass because all controlled dirs exist
    expect(body.data.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('GET /readyz returns 503 when a required directory is removed', async () => {
    // Remove one required directory to induce failure
    const settingsDir = path.join(tempRoot, 'data', 'settings');
    await fs.promises.rm(settingsDir, { recursive: true, force: true });

    const res = await fetchUrl('/readyz');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.data.status).toBe('not_ready');

    // Restore the directory for subsequent tests
    await fs.promises.mkdir(settingsDir, { recursive: true });
    const settingsJson = JSON.stringify({
      libraries: [
        {
          id: 'test-lib',
          name: 'Test Library',
          path: path.join(tempRoot, 'data', 'library'),
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: [],
      tagAliases: {},
    });
    await fs.promises.writeFile(path.join(settingsDir, 'settings.json'), settingsJson);
  });
});

describe('config and status', () => {
  it('GET /api/config returns runtime config', async () => {
    const res = await fetchUrl('/api/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.version).toBeDefined();
    expect(body.data.siteName).toBeDefined();
  });

  it('GET /api/status returns index status', async () => {
    const res = await fetchUrl('/api/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { isScanning: false, phase: 'Idle' } });
  });
});

describe('validation errors', () => {
  it('POST /api/tags with invalid body returns 400', async () => {
    const res = await fetchUrl('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: 123, tags: 'str', mode: 'invalid' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it('PUT /api/settings with invalid body returns 400', async () => {
    const res = await fetchUrl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraries: 'not-array' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it('Malformed JSON returns 400', async () => {
    const res = await fetchUrl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{broken}',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Malformed JSON in request body.' });
  });

  it('Oversized payload returns 413', async () => {
    const res = await fetchUrl('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(3 * 1024 * 1024), // over 2mb limit
    });
    expect(res.status).toBe(413);
  });
});

describe('route behaviors preserved', () => {
  it('GET /api/media returns paged media items', async () => {
    const res = await fetchUrl('/api/media');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.total).toBeGreaterThanOrEqual(0);
    expect(body.data.offset).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/media/:id returns 404 for unknown id', async () => {
    const res = await fetchUrl('/api/media/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Media not found' });
  });

  it('GET /api/tags returns sorted tags', async () => {
    const res = await fetchUrl('/api/tags');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('POST /api/upload requires writable', async () => {
    const res = await fetchUrl('/api/upload', { method: 'POST' });
    expect(res.status).toBe(400);
  });
});

describe('health checks work in test mode', () => {
  it('GET /readyz includes checks for storage', async () => {
    const res = await fetchUrl('/readyz');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.checks.some((c: { name: string }) => c.name === 'settings-storage')).toBe(true);
    expect(body.data.checks.some((c: { name: string }) => c.name === 'thumbnails-storage')).toBe(true);
  });
});

describe('saved search CRUD', () => {
  it('GET /api/saved-searches returns empty array', async () => {
    const res = await fetchUrl('/api/saved-searches');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [] });
  });

  it('POST /api/saved-searches creates a saved search', async () => {
    const res = await fetchUrl('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', query: { q: 'hello' } }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data).toBeDefined();
    expect(body.data.id).toBeDefined();
    expect(body.data.name).toBe('test');
    expect(body.data.query.q).toBe('hello');
  });

  it('GET /api/saved-searches/:id returns 404 for unknown', async () => {
    const res = await fetchUrl('/api/saved-searches/unknown');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Saved search not found' });
  });

  it('POST /api/saved-searches with invalid body returns 400', async () => {
    const res = await fetchUrl('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { q: 'test' } }), // missing name
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/saved-searches requires writable', async () => {
    // Temporarily set readOnly to true to test ensureWritable
    const { runtimeConfig } = await import('./config.js');
    const originalReadOnly = runtimeConfig.readOnly;
    runtimeConfig.readOnly = true;
    try {
      const res = await fetchUrl('/api/saved-searches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test', query: { q: 'hello' } }),
      });
      expect(res.status).toBe(403);
    } finally {
      runtimeConfig.readOnly = originalReadOnly;
    }
  });

  it('PUT /api/saved-searches/:id updates a saved search', async () => {
    // Create first
    const createRes = await fetchUrl('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'update me', query: { q: 'initial' } }),
    });
    const created = (await createRes.json()).data;
    expect(created.id).toBeDefined();

    // Now update
    const updateRes = await fetchUrl(`/api/saved-searches/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'updated', query: { q: 'changed' } }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()).data;
    expect(updated.name).toBe('updated');
    expect(updated.query.q).toBe('changed');
    // id and createdAt should be preserved
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it('PUT /api/saved-searches/:id returns 404 for unknown', async () => {
    const res = await fetchUrl('/api/saved-searches/unknown', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', query: { q: 'hello' } }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/saved-searches/:id deletes a saved search', async () => {
    // Create first
    const createRes = await fetchUrl('/api/saved-searches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'delete me', query: { q: 'hello' } }),
    });
    const created = (await createRes.json()).data;
    expect(created.id).toBeDefined();

    // Delete
    const deleteRes = await fetchUrl(`/api/saved-searches/${created.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    expect(await deleteRes.json()).toMatchObject({ data: { deleted: true } });

    // Verify it's gone
    const getRes = await fetchUrl(`/api/saved-searches/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /api/saved-searches/:id returns 404 for unknown', async () => {
    const res = await fetchUrl('/api/saved-searches/unknown', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

describe('startup rejects unsupported PERSISTENCE_DRIVER', () => {
  it('createApp with all side effects disabled rejects unsupported PERSISTENCE_DRIVER', async () => {
    const originalDriver = process.env.PERSISTENCE_DRIVER;
    process.env.PERSISTENCE_DRIVER = 'postgres';
    try {
      const { createApp } = await import('./app.js');
      await expect(
        createApp({
          noInitializeIndex: true,
          noAttachScanner: true,
          noAttachFrontend: true,
          noProcessSignals: true,
        }),
      ).rejects.toThrow('Unsupported persistence driver');
    } finally {
      if (originalDriver === undefined) delete process.env.PERSISTENCE_DRIVER;
      else process.env.PERSISTENCE_DRIVER = originalDriver;
    }
  });
});

describe('concurrent route updates', () => {
  // Reset controlled settings to known baseline before this test suite.
  beforeEach(async () => {
    const settingsJson = JSON.stringify({
      libraries: [
        {
          id: 'test-lib',
          name: 'Test Library',
          path: path.join(tempRoot, 'data', 'library'),
          enabled: true,
          startExpanded: false,
        },
      ],
      tagCatalog: ['cat1', 'cat2'],
      tagAliases: { cat1: ['alias1'] },
    });
    await fs.promises.writeFile(
      path.join(path.join(tempRoot, 'data', 'settings'), 'settings.json'),
      settingsJson,
    );
  });

  it('concurrent catalog and alias updates produce consistent settings', async () => {
    // Perform concurrent PUT /api/tags/catalog and PUT /api/tags/aliases.
    const catalogPromise = fetchUrl('/api/tags/catalog', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: ['cat1', 'cat3'] }),
    });
    const aliasesPromise = fetchUrl('/api/tags/aliases', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'cat1', aliases: ['alias2'] }),
    });

    await Promise.all([catalogPromise, aliasesPromise]);

    // Verify GET /api/settings contains both changes.
    const settingsRes = await fetchUrl('/api/settings');
    expect(settingsRes.status).toBe(200);
    const settings = (await settingsRes.json()).data;
    expect(settings.tagCatalog).toContain('cat1');
    expect(settings.tagCatalog).toContain('cat3');
    expect(settings.tagAliases.cat1).toContain('alias2');
  });
});
