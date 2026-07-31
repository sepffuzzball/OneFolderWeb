import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import express, { type Request, type Response, type NextFunction } from 'express';
import mime from 'mime-types';
import multer from 'multer';
import { runtimeConfig, paths, serverConfig } from './config.js';
import { closeMetadataTools } from './metadata.js';
import {
  addMediaFilesToIndex,
  buildFolderTree,
  createFolder,
  currentIndexStatus,
  filterMedia,
  findMedia,
  initializeIndex,
  listKnownTags,
  listTagSummaries,
  moveFolder,
  moveMedia,
  normalizeTag,
  removeTagEverywhere,
  renameTagEverywhere,
  refreshTagSettings,
  resolveMediaPath,
  resolveThumbnailPath,
  resolveTagAliasFromMap,
  scheduleLibraryScan,
  scanLibraries,
  targetUploadDirectory,
  trashMedia,
  updateTags,
} from './scanner.js';
import { loadSettings, saveSettings, updateSettings } from './storage.js';
import type {
  AppSettings,
  CreateFolderRequest,
  DeleteMediaRequest,
  MediaItem,
  MediaQuery,
  MoveFolderRequest,
  MoveMediaRequest,
  TagAliasUpdateRequest,
  RenameTagRequest,
  TagCatalogUpdateRequest,
  TagSummary,
  TagUpdateRequest,
} from '../shared/types.js';
import {
  ValidationError,
  validateAppSettings,
  validateTagUpdateRequest,
  validateTagCatalogUpdateRequest,
  validateTagAliasUpdateRequest,
  validateRenameTagRequest,
  validateCreateFolderRequest,
  validateMoveMediaRequest,
  validateMoveFolderRequest,
  validateDeleteMediaRequest,
  validateDeleteTagsQuery,
  validateMediaQuery,
  validateDownloadQuery,
  validateUploadMultipart,
} from './validation.js';

const upload = multer({
  dest: path.join(paths.settingsDir, 'incoming'),
  limits: {
    fileSize: runtimeConfig.maxUploadMb * 1024 * 1024,
  },
});

/**
 * Options for createApp — all default to production behavior.
 */
export type AppOptions = {
  /** Skip index initialization / initial scan */
  noInitializeIndex?: boolean;
  /** Skip watcher + interval startup */
  noAttachScanner?: boolean;
  /** Skip frontend / static middleware */
  noAttachFrontend?: boolean;
  /** Skip process signal handler registration */
  noProcessSignals?: boolean;
};

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function ensureWritable(req: Request, res: Response, next: () => void) {
  if (runtimeConfig.readOnly) {
    res.status(403).json({ error: 'This OneFolder Web instance is read-only.' });
    return;
  }
  next();
}

export async function createApp(options?: AppOptions): Promise<express.Express> {
  if (!options?.noInitializeIndex) {
    await initializeIndex();
  }

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Health and readiness probes
  app.get('/healthz', (_req, res) => res.json({ data: { status: 'ok' } }));

  app.get('/readyz', asyncHandler(async (_req, res) => {
    const checks: Array<{ name: string; ok: boolean }> = [];

    // Check settings storage
    try {
      const settings = await loadSettings();
      const settingsDir = path.join(paths.settingsDir);
      try {
        await fs.promises.access(settingsDir, fs.constants.R_OK | fs.constants.W_OK);
        checks.push({ name: 'settings-storage', ok: true });
      } catch {
        checks.push({ name: 'settings-storage', ok: false });
      }
    } catch {
      checks.push({ name: 'settings-storage', ok: false });
    }

    // Check thumbnail storage
    try {
      const thumbDir = path.join(paths.thumbnailDir);
      await fs.promises.access(thumbDir, fs.constants.R_OK | fs.constants.W_OK);
      checks.push({ name: 'thumbnails-storage', ok: true });
    } catch {
      checks.push({ name: 'thumbnails-storage', ok: false });
    }

    // Check backup storage when backups are enabled
    if (runtimeConfig.backupRetentionDays > 0 && runtimeConfig.backupIntervalHours > 0) {
      try {
        const backupDir = path.join(paths.backupDir);
        await fs.promises.access(backupDir, fs.constants.R_OK | fs.constants.W_OK);
        checks.push({ name: 'backups-storage', ok: true });
      } catch {
        checks.push({ name: 'backups-storage', ok: false });
      }
    }

    // Check enabled libraries
    try {
      const libraries = (await loadSettings()).libraries;
      for (const lib of libraries.filter((l) => l.enabled)) {
        try {
          await fs.promises.access(lib.path, fs.constants.R_OK | (runtimeConfig.readOnly ? 0 : fs.constants.W_OK));
          checks.push({ name: `library-${lib.id}`, ok: true });
        } catch {
          checks.push({ name: `library-${lib.id}`, ok: false });
        }
      }
    } catch {
      // ignore
    }

    // Check trash storage
    if (!runtimeConfig.readOnly) {
      try {
        const trashDir = path.join(paths.trashDir);
        await fs.promises.access(trashDir, fs.constants.W_OK);
        checks.push({ name: 'trash-storage', ok: true });
      } catch {
        checks.push({ name: 'trash-storage', ok: false });
      }
    }

    const allOk = checks.every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({ data: { status: allOk ? 'ready' : 'not_ready', checks } });
  }));

  app.get('/api/config', (_req, res) => res.json({ data: runtimeConfig }));

  app.get('/api/status', (_req, res) => res.json({ data: currentIndexStatus() }));

  app.get(
    '/api/settings',
    asyncHandler(async (_req, res) => {
      res.json({ data: await loadSettings() });
    }),
  );

  app.put(
    '/api/settings',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const settings = validateAppSettings(req.body);
      const next = await saveSettings(settings);
      await refreshTagSettings();
      res.json({ data: next });
      scheduleLibraryScan();
    }),
  );

  app.post(
    '/api/scan',
    asyncHandler(async (_req, res) => {
      res.json({ data: await scanLibraries() });
    }),
  );

  app.get('/api/media', (req, res) => {
    const validated = validateMediaQuery(req.query);
    const tagExpression = validated.tagExpression;
    const tags = tagExpression && !hasTagExpressionOperators(tagExpression) ? tagExpression.split(',').filter(Boolean) : [];
    const offset = boundedNumber(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedNumber(req.query.limit, 240, 1, 1000);
    const query: MediaQuery = {
      q: validated.q,
      tags,
      tagExpression,
      folder: validated.folder,
      libraryId: validated.libraryId,
    };
    const filtered = filterMedia(query);
    const items = filtered.slice(offset, offset + limit);
    res.json({
      data: {
        items,
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + items.length < filtered.length,
      },
    });
  });

  app.get('/api/media/:id', (req, res) => {
    const item = findMedia(req.params.id);
    if (!item) {
      res.status(404).json({ error: 'Media not found' });
      return;
    }
    res.json({ data: item });
  });

  app.get(
    '/api/tree',
    asyncHandler(async (_req, res) => {
      res.json({ data: await buildFolderTree() });
    }),
  );

  app.post(
    '/api/tags',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateTagUpdateRequest(req.body);
      res.json({ data: await updateTags(payload) });
    }),
  );

  app.get(
    '/api/tags',
    asyncHandler(async (_req, res) => {
      const settings = await loadSettings();
      const tags = Array.from(
        new Set([...settings.tagCatalog, ...listKnownTags()].map((tag) => resolveTagAliasFromMap(tag, settings.tagAliases)).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b));
      res.json({ data: tags });
    }),
  );

  app.get('/api/tags/summary', (_req, res) => {
    res.json({ data: listTagSummaries() satisfies TagSummary[] });
  });

  app.put(
    '/api/tags/catalog',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateTagCatalogUpdateRequest(req.body);
      const next = await updateSettings((current) => ({
        ...current,
        tagCatalog: Array.from(
          new Set(
            payload.tags.map((tag) =>
              resolveTagAliasFromMap(tag, current.tagAliases),
            ).filter(Boolean),
          ),
        ).sort((a, b) => a.localeCompare(b)),
      }));
      await refreshTagSettings();
      res.json({ data: next.tagCatalog });
    }),
  );

  app.put(
    '/api/tags/aliases',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateTagAliasUpdateRequest(req.body);
      const tag = normalizeTag(payload.tag);
      if (!tag) {
        res.status(400).json({ error: 'Tag is required.' });
        return;
      }
      const aliases = Array.from(
        new Set(
          (payload.aliases ?? [])
            .map(normalizeTag)
            .filter((alias) => alias && alias !== tag),
        ),
      ).sort((a, b) => a.localeCompare(b));
      const next = await updateSettings((current) => {
        const nextAliases = { ...current.tagAliases };
        for (const [existingTag, existingAliases] of Object.entries(nextAliases)) {
          const normalizedExisting = normalizeTag(existingTag);
          if (normalizedExisting === tag) continue;
          nextAliases[existingTag] = existingAliases.filter(
            (alias) =>
              !aliases.includes(normalizeTag(alias)) &&
              normalizeTag(alias) !== tag,
          );
          if (nextAliases[existingTag].length === 0) delete nextAliases[existingTag];
        }
        if (aliases.length > 0) nextAliases[tag] = aliases;
        else delete nextAliases[tag];
        return {
          ...current,
          tagAliases: nextAliases,
        };
      });
      await refreshTagSettings();
      res.json({ data: next.tagAliases });
    }),
  );

  app.post(
    '/api/tags/rename',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateRenameTagRequest(req.body);
      const from = normalizeTag(payload.from);
      const to = normalizeTag(payload.to);
      // Complete renameTagEverywhere (scanner/filesystem work) before
      // calling updateSettings, which is a pure synchronous transform.
      const renamed = await renameTagEverywhere(from, to);
      await updateSettings((current) => ({
        ...current,
        tagCatalog: current.tagCatalog
          .map((tag) => {
            const normalized = normalizeTag(tag);
            if (normalized.toLowerCase() === from.toLowerCase()) return to;
            if (normalized.toLowerCase().startsWith(`${from.toLowerCase()}/`))
              return `${to}${normalized.slice(from.length)}`;
            return normalized;
          })
          .filter(Boolean),
        tagAliases: renameTagAliases(current.tagAliases, from, to),
      }));
      res.json({ data: renamed });
    }),
  );

  app.delete(
    '/api/tags',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const tag = validateDeleteTagsQuery(req.query.tag);
      const normalizedTag = normalizeTag(tag.tag);
      // Complete removeTagEverywhere (scanner/filesystem work) before
      // calling updateSettings, which is a pure synchronous transform.
      const removed = await removeTagEverywhere(normalizedTag);
      await updateSettings((current) => ({
        ...current,
        tagCatalog: current.tagCatalog.filter((catalogTag) => {
          const normalized = normalizeTag(catalogTag).toLowerCase();
          const target = normalizedTag.toLowerCase();
          return normalized !== target && !normalized.startsWith(`${target}/`);
        }),
        tagAliases: removeTagAliases(current.tagAliases, normalizedTag),
      }));
      res.json({ data: removed });
    }),
  );

  app.post(
    '/api/folders',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateCreateFolderRequest(req.body);
      const relativePath = await createFolder(payload.libraryId, payload.parentPath, payload.name);
      res.json({ data: { relativePath } });
    }),
  );

  app.post(
    '/api/upload',
    ensureWritable,
    upload.array('files', 250),
    asyncHandler(async (req, res) => {
      try {
        const uploadBody = validateUploadMultipart(req.body);
        const files = (req.files ?? []) as Express.Multer.File[];
        const libraryId = uploadBody.libraryId;
        const targetPath = uploadBody.targetPath;
        const targetDir = await targetUploadDirectory(libraryId, targetPath);
        const saved: string[] = [];
        const savedPaths: string[] = [];
        for (const file of files) {
          const filename = safeFileName(file.originalname);
          const finalPath = await uniquePath(path.join(targetDir, filename));
          await moveUploadedFile(file.path, finalPath);
          saved.push(path.basename(finalPath));
          savedPaths.push(finalPath);
        }
        await addMediaFilesToIndex(libraryId, savedPaths, targetPath);
        res.json({ data: { saved } });
      } catch (error) {
        // Clean up temp files created by multer before propagating
        for (const tempFile of (req.files ?? []) as Express.Multer.File[]) {
          try {
            await fs.promises.rm(tempFile.path, { force: true });
          } catch {
            // ignore cleanup errors
          }
        }
        throw error; // let asyncHandler and error middleware handle it
      }
    }),
  );

  app.post(
    '/api/move',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateMoveMediaRequest(req.body);
      res.json({ data: await moveMedia(payload) });
    }),
  );

  app.post(
    '/api/folders/move',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateMoveFolderRequest(req.body);
      res.json({ data: await moveFolder(payload) });
    }),
  );

  app.post(
    '/api/delete',
    ensureWritable,
    asyncHandler(async (req, res) => {
      const payload = validateDeleteMediaRequest(req.body);
      res.json({ data: await trashMedia(payload) });
    }),
  );

  app.get(
    '/thumb/:id',
    asyncHandler(async (req, res) => {
      const size = req.query.size === 'preview' ? 'preview' : 'grid';
      const thumbnailPath = resolveThumbnailPath(String(req.params.id), size);
      if (!thumbnailPath || !fs.existsSync(thumbnailPath)) {
        res.status(404).end();
        return;
      }
      res.type('image/jpeg').sendFile(thumbnailPath);
    }),
  );

  app.get(
    '/file/:id',
    asyncHandler(async (req, res) => {
      const filePath = await resolveMediaPath(String(req.params.id));
      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).end();
        return;
      }
      res.type(mime.lookup(filePath) || 'application/octet-stream').sendFile(filePath);
    }),
  );

  app.get(
    '/download/:id',
    asyncHandler(async (req, res) => {
      const item = findMedia(String(req.params.id));
      const filePath = item ? await resolveMediaPath(item.id) : undefined;
      if (!item || !filePath || !fs.existsSync(filePath)) {
        res.status(404).end();
        return;
      }
      res.download(filePath, item.name);
    }),
  );

  app.get(
    '/api/download',
    asyncHandler(async (req, res) => {
      const downloadQuery = validateDownloadQuery(req.query.ids);
      const ids = downloadQuery.ids;
      const files: Array<{ item: MediaItem; filePath: string }> = [];
      for (const id of ids) {
        const item = findMedia(id);
        const filePath = item ? await resolveMediaPath(item.id) : undefined;
        if (item && filePath && fs.existsSync(filePath)) files.push({ item, filePath });
      }
      if (files.length === 0) {
        res.status(404).json({ error: 'No downloadable files found.' });
        return;
      }
      if (files.length === 1) {
        res.download(files[0].filePath, files[0].item.name);
        return;
      }
      await sendZipDownload(res, files);
    }),
  );

  if (!options?.noAttachFrontend) {
    await attachFrontend(app);
  }
  if (!options?.noAttachScanner) {
    attachScanner();
  }
  if (!options?.noProcessSignals) {
    process.once('SIGINT', () => void closeMetadataTools().finally(() => process.exit(0)));
    process.once('SIGTERM', () => void closeMetadataTools().finally(() => process.exit(0)));
  }

  // Error middleware (four arguments) after all routes
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      // Malformed JSON
      res.status(400).json({ error: 'Malformed JSON in request body.' });
      return;
    }
    if (err instanceof Error && 'type' in err && err.type === 'entity.too.large') {
      // Payload too large from body-parser
      res.status(413).json({ error: 'Request entity too large.' });
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_PART_COUNT') {
        res.status(413).json({ error: err.message });
        return;
      }
      // Other multer errors
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    // Otherwise fall through to 500
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  });

  return app;
}

async function attachFrontend(app: express.Express): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
    return;
  }

  app.use(express.static(paths.publicDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(paths.publicDir, 'index.html'));
  });
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function renameTagAliases(tagAliases: Record<string, string[]>, from: string, to: string): Record<string, string[]> {
  const normalizedFrom = normalizeTag(from).toLowerCase();
  const normalizedTo = normalizeTag(to);
  const renamed: Record<string, string[]> = {};
  for (const [tag, aliases] of Object.entries(tagAliases)) {
    const normalizedTag = normalizeTag(tag);
    const nextTag =
      normalizedTag.toLowerCase() === normalizedFrom
        ? normalizedTo
        : normalizedTag.toLowerCase().startsWith(`${normalizedFrom}/`)
          ? `${normalizedTo}${normalizedTag.slice(normalizedFrom.length)}`
          : normalizedTag;
    const nextAliases = aliases
      .map((alias) => {
        const normalizedAlias = normalizeTag(alias);
        if (normalizedAlias.toLowerCase() === normalizedFrom) return normalizedTo;
        if (normalizedAlias.toLowerCase().startsWith(`${normalizedFrom}/`)) return `${normalizedTo}${normalizedAlias.slice(normalizedFrom.length)}`;
        return normalizedAlias;
      })
      .filter((alias) => alias && alias !== nextTag);
    if (nextTag && nextAliases.length > 0) renamed[nextTag] = Array.from(new Set([...(renamed[nextTag] ?? []), ...nextAliases])).sort((a, b) =>
      a.localeCompare(b),
    );
  }
  return renamed;
}

function removeTagAliases(tagAliases: Record<string, string[]>, tag: string): Record<string, string[]> {
  const target = normalizeTag(tag).toLowerCase();
  const kept: Record<string, string[]> = {};
  for (const [aliasTag, aliases] of Object.entries(tagAliases)) {
    const normalizedTag = normalizeTag(aliasTag).toLowerCase();
    if (normalizedTag === target || normalizedTag.startsWith(`${target}/`)) continue;
    const nextAliases = aliases.filter((alias) => {
      const normalizedAlias = normalizeTag(alias).toLowerCase();
      return normalizedAlias !== target && !normalizedAlias.startsWith(`${target}/`);
    });
    if (nextAliases.length > 0) kept[aliasTag] = nextAliases;
  }
  return kept;
}

function hasTagExpressionOperators(value: string): boolean {
  return /[(),]|\b(?:and|or)\b/i.test(value);
}

async function sendZipDownload(res: Response, files: Array<{ item: MediaItem; filePath: string }>): Promise<void> {
  res.status(200);
  res.type('application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName()}"`);

  const centralDirectory: Buffer[] = [];
  const usedNames = new Set<string>();
  let offset = 0;

  for (const file of files) {
    const stat = await fs.promises.stat(file.filePath);
    if (stat.size > 0xffffffff) throw new Error(`${file.item.name} is too large for standard ZIP download.`);
    const crc = await crc32File(file.filePath);
    const name = uniqueZipEntryName(file.item.relativePath || file.item.name, usedNames);
    const nameBuffer = Buffer.from(name, 'utf8');
    const { time, date } = zipDateTime(stat.mtime);
    const localHeader = zipLocalHeader(nameBuffer, crc, stat.size, time, date);
    res.write(localHeader);

    const entryOffset = offset;
    offset += localHeader.length;
    await streamFileToResponse(file.filePath, res);
    offset += stat.size;

    centralDirectory.push(zipCentralDirectoryHeader(nameBuffer, crc, stat.size, time, date, entryOffset));
  }

  const centralOffset = offset;
  const centralSize = centralDirectory.reduce((total, header) => total + header.length, 0);
  for (const header of centralDirectory) res.write(header);
  res.end(zipEndOfCentralDirectory(centralDirectory.length, centralSize, centralOffset));
}

function zipName(): string {
  return `onefolder-${new Date().toISOString().slice(0, 10)}.zip`;
}

function uniqueZipEntryName(relativePath: string, usedNames: Set<string>): string {
  const clean = normalizeZipPath(relativePath);
  let candidate = clean;
  let index = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    const parsed = path.parse(clean);
    candidate = normalizeZipPath(path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`));
    index += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function normalizeZipPath(value: string): string {
  return value.replace(/\\/g, '/').split('/').map(safeFileName).filter(Boolean).join('/') || 'download';
}

function zipLocalHeader(name: Buffer, crc: number, size: number, time: number, date: number): Buffer {
  const header = Buffer.alloc(30 + name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  name.copy(header, 30);
  return header;
}

function zipCentralDirectoryHeader(name: Buffer, crc: number, size: number, time: number, date: number, offset: number): Buffer {
  const header = Buffer.alloc(46 + name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  name.copy(header, 46);
  return header;
}

function zipEndOfCentralDirectory(entries: number, centralSize: number, centralOffset: number): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entries, 8);
  header.writeUInt16LE(entries, 10);
  header.writeUInt32LE(centralSize, 12);
  header.writeUInt32LE(centralOffset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

function zipDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function crc32File(filePath: string): Promise<number> {
  let crc = 0xffffffff;
  for await (const chunk of fs.createReadStream(filePath)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const byte of buffer) crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function streamFileToResponse(filePath: string, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res, { end: false });
  });
}

function attachScanner() {
  const queueScan = () => {
    scheduleLibraryScan(2_500);
  };

  const watcher = chokidar.watch(paths.dataRoot, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 250 },
  });
  watcher.on('add', queueScan).on('change', queueScan).on('unlink', queueScan).on('addDir', queueScan).on('unlinkDir', queueScan);
  setInterval(() => void scanLibraries(), serverConfig.scanIntervalMs).unref();
}

function safeFileName(value: string): string {
  const parsed = path.parse(value);
  const base = parsed.name.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || 'upload';
  const ext = parsed.ext.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').toLowerCase();
  return `${base}${ext}`;
}

async function uniquePath(initialPath: string): Promise<string> {
  const parsed = path.parse(initialPath);
  let candidate = initialPath;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${index}${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

async function moveUploadedFile(source: string, destination: string): Promise<void> {
  try {
    await fs.promises.rename(source, destination);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EXDEV') throw error;
    const pendingDestination = await uniquePath(path.join(path.dirname(destination), `.uploading-${path.basename(destination)}`));
    try {
      await fs.promises.copyFile(source, pendingDestination, fs.constants.COPYFILE_EXCL);
      await fs.promises.rename(pendingDestination, destination);
    } catch (copyError) {
      await fs.promises.rm(pendingDestination, { force: true });
      throw copyError;
    }
    try {
      await fs.promises.unlink(source);
    } catch (unlinkError) {
      console.warn(`Uploaded file was copied to ${destination}, but temporary file cleanup failed for ${source}.`, unlinkError);
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
