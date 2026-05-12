import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import type { FolderNode, IndexStatus, LibrarySettings, MediaItem, MediaQuery, TagSummary } from '../shared/types.js';
import { paths, runtimeConfig } from './config.js';
import { readMetadata, writeMetadata } from './metadata.js';
import { loadIndex, loadSettings, saveIndex } from './storage.js';
import { canCreateThumbnail, ensureThumbnail, isMediaExtension, mediaKindForExtension, thumbnailPathFor, type ThumbnailSize } from './thumbnails.js';

let cachedFiles: MediaItem[] = [];
let cachedTagCatalog: string[] = [];
let cachedAliasCanonical = new Map<string, string>();
let cachedCanonicalAliases = new Map<string, Set<string>>();
let scanInFlight: Promise<MediaItem[]> | undefined;
let indexStatus: IndexStatus = {
  isScanning: false,
  phase: 'Idle',
  filesSeen: 0,
  filesIndexed: 0,
  totalFiles: 0,
  currentPath: '',
};

type TagExpressionNode =
  | { type: 'tag'; value: string }
  | { type: 'and'; left: TagExpressionNode; right: TagExpressionNode }
  | { type: 'or'; left: TagExpressionNode; right: TagExpressionNode };

type TagExpressionToken =
  | { type: 'tag'; value: string }
  | { type: 'and' | 'or' | 'open' | 'close' };

export async function initializeIndex(): Promise<MediaItem[]> {
  const index = await loadIndex();
  cachedFiles = index.files;
  void scanLibraries();
  return currentFiles();
}

export function currentFiles(): MediaItem[] {
  return filterBlacklisted(cachedFiles);
}

export function currentIndexStatus(): IndexStatus {
  return { ...indexStatus, totalFiles: cachedFiles.length };
}

export async function scanLibraries(): Promise<MediaItem[]> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = doScan().finally(() => {
    scanInFlight = undefined;
  });
  return scanInFlight;
}

export async function refreshTagSettings(): Promise<void> {
  const settings = await loadSettings();
  cachedTagCatalog = settings.tagCatalog.map(normalizeTag).filter(Boolean);
  cacheTagAliases(settings.tagAliases);
}

async function doScan(): Promise<MediaItem[]> {
  const started = Date.now();
  indexStatus = {
    ...indexStatus,
    isScanning: true,
    phase: 'Scanning libraries',
    filesSeen: 0,
    filesIndexed: 0,
    currentPath: '',
    startedAt: new Date(started).toISOString(),
  };
  const settings = await loadSettings();
  cachedTagCatalog = settings.tagCatalog.map(normalizeTag).filter(Boolean);
  cacheTagAliases(settings.tagAliases);
  const previousByKey = new Map(cachedFiles.map((item) => [`${item.libraryId}:${item.relativePath}`, item]));
  const discovered: MediaItem[] = [];
  try {
    for (const library of settings.libraries.filter((item) => item.enabled)) {
      indexStatus = { ...indexStatus, phase: `Scanning ${library.name}`, currentPath: library.path };
      await fs.promises.mkdir(library.path, { recursive: true });
      const files = await walkLibrary(library, library.path, previousByKey);
      discovered.push(...files);
    }
    cachedFiles = discovered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    await saveIndex(cachedFiles);
    return currentFiles();
  } finally {
    const finished = Date.now();
    indexStatus = {
      ...indexStatus,
      isScanning: false,
      phase: 'Idle',
      currentPath: '',
      totalFiles: cachedFiles.length,
      lastFinishedAt: new Date(finished).toISOString(),
      lastDurationMs: finished - started,
    };
  }
}

async function walkLibrary(
  library: LibrarySettings,
  dir: string,
  previousByKey: Map<string, MediaItem>,
): Promise<MediaItem[]> {
  if (isPathInside(paths.trashDir, dir)) return [];
  const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
  const items: MediaItem[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      items.push(...(await walkLibrary(library, absolutePath, previousByKey)));
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).slice(1).toLowerCase();
    if (!isMediaExtension(extension)) continue;
    indexStatus = {
      ...indexStatus,
      filesSeen: indexStatus.filesSeen + 1,
      currentPath: normalizeSlashes(path.relative(library.path, absolutePath)),
    };
    const item = await buildMediaItem(library, absolutePath, extension, previousByKey);
    if (item) items.push(item);
  }
  return items;
}

async function buildMediaItem(
  library: LibrarySettings,
  absolutePath: string,
  extension: string,
  previousByKey: Map<string, MediaItem>,
): Promise<MediaItem | undefined> {
  try {
    const stat = await fs.promises.stat(absolutePath);
    const relativePath = normalizeSlashes(path.relative(library.path, absolutePath));
    const id = mediaId(library.id, relativePath);
    const previous = previousByKey.get(`${library.id}:${relativePath}`);
    const modifiedAt = stat.mtime.toISOString();
    const thumbnailAvailable = canCreateThumbnail(extension) && fs.existsSync(thumbnailPathFor(id, 'grid'));
    if (
      previous &&
      previous.size === stat.size &&
      previous.modifiedAt === modifiedAt &&
      (!canCreateThumbnail(extension) || thumbnailAvailable)
    ) {
      return {
        ...previous,
        libraryName: library.name,
        thumbnailUrl: thumbnailAvailable ? `/thumb/${id}?size=grid` : `/file/${id}`,
        previewThumbnailUrl: thumbnailAvailable ? `/thumb/${id}?size=preview` : `/file/${id}`,
        fileUrl: `/file/${id}`,
      };
    }

    indexStatus = {
      ...indexStatus,
      phase: 'Reading metadata',
      filesIndexed: indexStatus.filesIndexed + 1,
      currentPath: relativePath,
    };
    const metadata = await readMetadata(absolutePath);
    const thumbnailOk = await ensureThumbnail(id, absolutePath, extension);
    const folder = normalizeSlashes(path.dirname(relativePath));
    const createdAt = metadata.createdAt ?? stat.birthtime.toISOString();
    return {
      id,
      libraryId: library.id,
      libraryName: library.name,
      relativePath,
      folder: folder === '.' ? '' : folder,
      name: path.basename(absolutePath),
      extension,
      kind: mediaKindForExtension(extension),
      mimeType: mime.lookup(extension) || 'application/octet-stream',
      size: stat.size,
      width: metadata.width,
      height: metadata.height,
      durationSeconds: metadata.durationSeconds,
      createdAt,
      modifiedAt,
      indexedAt: new Date().toISOString(),
      tags: metadata.tags,
      description: metadata.description,
      artist: metadata.artist,
      thumbnailUrl: thumbnailOk ? `/thumb/${id}?size=grid` : `/file/${id}`,
      previewThumbnailUrl: thumbnailOk ? `/thumb/${id}?size=preview` : `/file/${id}`,
      fileUrl: `/file/${id}`,
    };
  } catch (error) {
    console.warn(`Could not index ${absolutePath}:`, error);
    return undefined;
  }
}

export function mediaId(libraryId: string, relativePath: string): string {
  return crypto.createHash('sha1').update(`${libraryId}:${normalizeSlashes(relativePath)}`).digest('hex');
}

export function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

export function normalizeTag(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s*(?:->|>|\\|\|\/|\|)\s*/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/^\/+|\/+$/g, '')
    .trim()
    .toLowerCase();
}

export function filterMedia(query: MediaQuery): MediaItem[] {
  const q = query.q?.trim().toLowerCase();
  const tags = (query.tags ?? []).map(resolveTagAlias).filter(Boolean);
  const tagExpression = query.tagExpression?.trim() ? parseTagExpression(query.tagExpression) : undefined;
  const folder = query.folder ? normalizeSlashes(query.folder) : undefined;

  return currentFiles().filter((item) => {
    if (query.libraryId && item.libraryId !== query.libraryId) return false;
    if (folder && item.folder !== folder && !item.folder.startsWith(`${folder}/`)) return false;
    if (tagExpression && !evaluateTagExpression(tagExpression, item.tags)) {
      return false;
    }
    if (!tagExpression && tags.length > 0 && !tags.every((tag) => item.tags.some((itemTag) => tagMatchesFilter(tag, itemTag)))) {
      return false;
    }
    if (q) {
      const haystack = [item.name, item.relativePath, item.folder, item.artist, item.description, ...expandTagAncestors(item.tags)]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export function tagExpressionMatches(expression: string, itemTags: string[]): boolean {
  const parsed = parseTagExpression(expression);
  return parsed ? evaluateTagExpression(parsed, itemTags) : true;
}

export function findMedia(id: string): MediaItem | undefined {
  return currentFiles().find((item) => item.id === id);
}

export async function resolveMediaPath(id: string): Promise<string | undefined> {
  const settings = await loadSettings();
  const item = cachedFiles.find((file) => file.id === id);
  const library = settings.libraries.find((candidate) => candidate.id === item?.libraryId);
  if (!item || !library) return undefined;
  const absolutePath = path.resolve(library.path, item.relativePath);
  if (!isPathInside(library.path, absolutePath)) return undefined;
  return absolutePath;
}

export function resolveThumbnailPath(id: string, size: ThumbnailSize = 'grid'): string | undefined {
  const item = currentFiles().find((file) => file.id === id);
  if (!item) return undefined;
  return thumbnailPathFor(id, size);
}

export async function updateTags(request: { ids: string[]; tags: string[]; mode: 'replace' | 'add' | 'remove'; description?: string }) {
  const settings = await loadSettings();
  const normalizedTags = canonicalizeRequestedTags(request.tags, settings.tagCatalog, settings.tagAliases);
  const files = cachedFiles.filter((item) => request.ids.includes(item.id));
  for (const item of files) {
    const absolutePath = await resolveMediaPath(item.id);
    if (!absolutePath) continue;
    const nextTags =
      request.mode === 'replace'
        ? normalizedTags
        : request.mode === 'add'
          ? Array.from(new Set([...item.tags, ...normalizedTags]))
          : item.tags.filter((tag) => !normalizedTags.some((removed) => tagMatchesFilter(removed, tag)));
    await writeMetadata(absolutePath, { tags: nextTags, description: request.description });
  }
  return scanLibraries();
}

export async function moveMedia(request: { ids: string[]; libraryId: string; targetPath?: string }) {
  const targetDir = await targetUploadDirectory(request.libraryId, request.targetPath);
  const files = cachedFiles.filter((item) => request.ids.includes(item.id));
  const moved: string[] = [];

  for (const item of files) {
    const sourcePath = await resolveMediaPath(item.id);
    if (!sourcePath) continue;
    const finalPath = await uniquePath(path.join(targetDir, item.name));
    if (path.resolve(sourcePath) === path.resolve(finalPath)) continue;
    try {
      await fs.promises.rename(sourcePath, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.promises.copyFile(sourcePath, finalPath);
      await fs.promises.unlink(sourcePath);
    }
    await Promise.all([
      fs.promises.rm(thumbnailPathFor(item.id, 'grid'), { force: true }).catch(() => undefined),
      fs.promises.rm(thumbnailPathFor(item.id, 'preview'), { force: true }).catch(() => undefined),
    ]);
    moved.push(item.id);
  }

  await scanLibraries();
  return { moved };
}

export async function moveFolder(request: { libraryId: string; sourcePath: string; targetLibraryId: string; targetPath?: string }) {
  const settings = await loadSettings();
  const sourceLibrary = settings.libraries.find((item) => item.id === request.libraryId);
  const targetLibrary = settings.libraries.find((item) => item.id === request.targetLibraryId);
  if (!sourceLibrary || !targetLibrary) throw new Error('Library not found');

  const sourceRelativePath = normalizeFolderPath(request.sourcePath);
  const targetRelativePath = normalizeFolderPath(request.targetPath ?? '');
  if (!sourceRelativePath) throw new Error('Cannot move a library root');

  const sourcePath = path.resolve(sourceLibrary.path, sourceRelativePath);
  if (!isPathInside(sourceLibrary.path, sourcePath)) throw new Error('Source folder escapes the library path');
  const sourceStat = await fs.promises.stat(sourcePath).catch(() => undefined);
  if (!sourceStat?.isDirectory()) throw new Error('Source folder not found');

  const targetDir = path.resolve(targetLibrary.path, targetRelativePath);
  if (!isPathInside(targetLibrary.path, targetDir)) throw new Error('Target folder escapes the library path');
  if (sourceLibrary.id === targetLibrary.id && isSameOrChildPath(targetRelativePath, sourceRelativePath)) {
    throw new Error('Cannot move a folder into itself');
  }

  const currentParent = normalizeFolderPath(path.dirname(sourceRelativePath));
  if (sourceLibrary.id === targetLibrary.id && currentParent === targetRelativePath) {
    return { relativePath: sourceRelativePath };
  }

  await fs.promises.mkdir(targetDir, { recursive: true });
  const destinationPath = await uniquePath(path.join(targetDir, path.basename(sourceRelativePath)));
  await moveDirectory(sourcePath, destinationPath);
  await Promise.all(
    cachedFiles
      .filter((item) => item.libraryId === sourceLibrary.id && isSameOrChildPath(item.folder, sourceRelativePath))
      .flatMap((item) => [
        fs.promises.rm(thumbnailPathFor(item.id, 'grid'), { force: true }).catch(() => undefined),
        fs.promises.rm(thumbnailPathFor(item.id, 'preview'), { force: true }).catch(() => undefined),
      ]),
  );
  await scanLibraries();
  return { relativePath: normalizeSlashes(path.relative(targetLibrary.path, destinationPath)) };
}

export async function trashMedia(request: { ids: string[] }) {
  const files = cachedFiles.filter((item) => request.ids.includes(item.id));
  const trashed: string[] = [];

  for (const item of files) {
    const sourcePath = await resolveMediaPath(item.id);
    if (!sourcePath) continue;
    const trashPath = await uniquePath(path.join(paths.trashDir, item.libraryId, item.relativePath));
    await fs.promises.mkdir(path.dirname(trashPath), { recursive: true });
    try {
      await fs.promises.rename(sourcePath, trashPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
      await fs.promises.copyFile(sourcePath, trashPath);
      await fs.promises.unlink(sourcePath);
    }
    await Promise.all([
      fs.promises.rm(thumbnailPathFor(item.id, 'grid'), { force: true }).catch(() => undefined),
      fs.promises.rm(thumbnailPathFor(item.id, 'preview'), { force: true }).catch(() => undefined),
    ]);
    trashed.push(item.id);
  }

  await scanLibraries();
  return { trashed };
}

export async function renameTagEverywhere(from: string, to: string) {
  const normalizedFrom = normalizeTag(from);
  const normalizedTo = normalizeTag(to);
  if (!normalizedFrom || !normalizedTo) throw new Error('Both tag names are required');

  const changed: string[] = [];
  for (const item of cachedFiles) {
    const nextTags = item.tags.map((tag) => replaceTagPath(tag, normalizedFrom, normalizedTo));
    if (nextTags.join('\u0000') === item.tags.join('\u0000')) continue;
    const absolutePath = await resolveMediaPath(item.id);
    if (!absolutePath) continue;
    await writeMetadata(absolutePath, { tags: Array.from(new Set(nextTags.map(normalizeTag).filter(Boolean))) });
    changed.push(item.id);
  }

  return { changed, files: await scanLibraries() };
}

export function resolveTagAlias(tag: string): string {
  const normalized = normalizeTag(tag);
  return cachedAliasCanonical.get(normalized) ?? normalized;
}

export async function removeTagEverywhere(tag: string) {
  const normalizedTag = normalizeTag(tag);
  if (!normalizedTag) throw new Error('Tag name is required');

  const changed: string[] = [];
  for (const item of cachedFiles) {
    const nextTags = item.tags.filter((itemTag) => !tagMatchesFilter(normalizedTag, itemTag));
    if (nextTags.length === item.tags.length) continue;
    const absolutePath = await resolveMediaPath(item.id);
    if (!absolutePath) continue;
    await writeMetadata(absolutePath, { tags: nextTags });
    changed.push(item.id);
  }

  return { changed, files: await scanLibraries() };
}

export function listKnownTags(): string[] {
  return Array.from(
    new Set([
      ...cachedTagCatalog,
      ...currentFiles().flatMap((item) => expandTagPathAncestors(item.tags.map(resolveTagAlias))),
    ]),
  ).sort((a, b) => a.localeCompare(b));
}

export function listTagSummaries(): TagSummary[] {
  const counts = new Map<string, number>();
  for (const tag of cachedTagCatalog.map(normalizeTag).filter(Boolean)) {
    counts.set(tag, 0);
  }

  for (const item of currentFiles()) {
    for (const tag of expandTagPathAncestors(item.tags.map(resolveTagAlias))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

export async function createFolder(libraryId: string, parentPath: string | undefined, name: string): Promise<string> {
  const settings = await loadSettings();
  const library = settings.libraries.find((item) => item.id === libraryId);
  if (!library) throw new Error('Library not found');
  const cleanName = name.replace(/[<>:"|?*]/g, '').trim();
  if (!cleanName) throw new Error('Folder name is required');
  const target = path.resolve(library.path, parentPath ?? '', cleanName);
  if (!isPathInside(library.path, target)) throw new Error('Folder escapes the library path');
  await fs.promises.mkdir(target, { recursive: true });
  await scanLibraries();
  return normalizeSlashes(path.relative(library.path, target));
}

export async function targetUploadDirectory(libraryId: string, targetPath: string | undefined): Promise<string> {
  const settings = await loadSettings();
  const library = settings.libraries.find((item) => item.id === libraryId);
  if (!library) throw new Error('Library not found');
  const target = path.resolve(library.path, targetPath ?? '');
  if (!isPathInside(library.path, target)) throw new Error('Upload path escapes the library path');
  await fs.promises.mkdir(target, { recursive: true });
  return target;
}

export async function buildFolderTree(files = currentFiles()): Promise<FolderNode[]> {
  const settings = await loadSettings();
  const libraries = new Map<string, FolderNode>();
  for (const librarySettings of settings.libraries.filter((library) => library.enabled)) {
    libraries.set(librarySettings.id, {
      id: librarySettings.id,
      libraryId: librarySettings.id,
      name: librarySettings.name,
      relativePath: '',
      depth: 0,
      itemCount: 0,
      children: [],
    });
    if (!runtimeConfig.hideEmptyFolders) {
      await addDirectoriesToTree(libraries.get(librarySettings.id)!, librarySettings.path);
    }
  }

  for (const item of files) {
    let library = libraries.get(item.libraryId);
    if (!library) {
      library = {
        id: item.libraryId,
        libraryId: item.libraryId,
        name: item.libraryName,
        relativePath: '',
        depth: 0,
        itemCount: 0,
        children: [],
      };
      libraries.set(item.libraryId, library);
    }
    library.itemCount += 1;
    let cursor = library;
    const parts = item.folder ? item.folder.split('/') : [];
    parts.forEach((part, index) => {
      const relativePath = parts.slice(0, index + 1).join('/');
      let child = cursor.children.find((node) => node.relativePath === relativePath);
      if (!child) {
        child = {
          id: `${item.libraryId}:${relativePath}`,
          libraryId: item.libraryId,
          name: part,
          relativePath,
          depth: index + 1,
          itemCount: 0,
          children: [],
        };
        cursor.children.push(child);
      }
      child.itemCount += 1;
      cursor = child;
    });
  }
  const sortNodes = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sortNodes(node.children));
  };
  const nodes = Array.from(libraries.values());
  sortNodes(nodes);
  return runtimeConfig.hideEmptyFolders ? nodes.filter((node) => node.itemCount > 0) : nodes;
}

async function addDirectoriesToTree(root: FolderNode, libraryPath: string): Promise<void> {
  const visit = async (absoluteDir: string, parent: FolderNode, depth: number) => {
    const entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = normalizeSlashes(path.relative(libraryPath, absolutePath));
      const child: FolderNode = {
        id: `${root.libraryId}:${relativePath}`,
        libraryId: root.libraryId,
        name: entry.name,
        relativePath,
        depth,
        itemCount: 0,
        children: [],
      };
      parent.children.push(child);
      await visit(absolutePath, child, depth + 1);
    }
  };
  await visit(libraryPath, root, 1);
}

function filterBlacklisted(files: MediaItem[]): MediaItem[] {
  const blacklist = runtimeConfig.blacklistedTags.map(normalizeTag);
  if (blacklist.length === 0) return files;
  return files.filter((item) => !item.tags.some((tag) => blacklist.some((blocked) => tagMatchesFilter(blocked, tag))));
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeFolderPath(value: string): string {
  const normalized = normalizeSlashes(value).replace(/^\/+|\/+$/g, '');
  return normalized === '.' ? '' : normalized;
}

function isSameOrChildPath(value: string, parent: string): boolean {
  const normalizedValue = normalizeFolderPath(value);
  const normalizedParent = normalizeFolderPath(parent);
  return normalizedValue === normalizedParent || normalizedValue.startsWith(`${normalizedParent}/`);
}

async function moveDirectory(source: string, destination: string): Promise<void> {
  try {
    await fs.promises.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const pendingDestination = await uniquePath(path.join(path.dirname(destination), `.moving-${path.basename(destination)}`));
    try {
      await fs.promises.cp(source, pendingDestination, { recursive: true, errorOnExist: true, force: false });
      await fs.promises.rename(pendingDestination, destination);
      await fs.promises.rm(source, { recursive: true, force: true });
    } catch (copyError) {
      await fs.promises.rm(pendingDestination, { recursive: true, force: true });
      throw copyError;
    }
  }
}

function tagMatchesFilter(filter: string, itemTag: string): boolean {
  const normalizedTag = normalizeTag(itemTag);
  const normalizedFilter = resolveTagAlias(filter);
  const tagEquivalents = equivalentTags(normalizedTag);
  const filterEquivalents = equivalentTags(normalizedFilter);
  if (tagEquivalents.some((tag) => filterEquivalents.some((filterTag) => tagMatchesNormalizedFilter(filterTag, tag)))) {
    return true;
  }

  const descendantTags = descendantsOfTag(normalizedFilter);
  return descendantTags.some((tagPath) => tagEquivalents.some((tag) => tagPath === tag || tagPath.endsWith(`/${tag}`)));
}

function tagMatchesNormalizedFilter(filter: string, itemTag: string): boolean {
  const normalizedTag = normalizeTag(itemTag);
  const normalizedFilter = normalizeTag(filter);
  if (
    normalizedTag === normalizedFilter ||
    normalizedTag.startsWith(`${normalizedFilter}/`) ||
    normalizedTag.split('/').includes(normalizedFilter)
  ) {
    return true;
  }
  return false;
}

function parseTagExpression(expression: string): TagExpressionNode | undefined {
  const tokens = tokenizeTagExpression(expression);
  let position = 0;

  const parseOr = (): TagExpressionNode | undefined => {
    let node = parseAnd();
    while (node && tokens[position]?.type === 'or') {
      position += 1;
      const right = parseAnd();
      if (!right) break;
      node = { type: 'or', left: node, right };
    }
    return node;
  };

  const parseAnd = (): TagExpressionNode | undefined => {
    let node = parsePrimary();
    while (node && tokens[position]?.type === 'and') {
      position += 1;
      const right = parsePrimary();
      if (!right) break;
      node = { type: 'and', left: node, right };
    }
    return node;
  };

  const parsePrimary = (): TagExpressionNode | undefined => {
    const token = tokens[position];
    if (!token) return undefined;
    if (token.type === 'tag') {
      position += 1;
      return { type: 'tag', value: token.value };
    }
    if (token.type === 'open') {
      position += 1;
      const node = parseOr();
      if (tokens[position]?.type === 'close') position += 1;
      return node;
    }
    return undefined;
  };

  return parseOr();
}

function tokenizeTagExpression(expression: string): TagExpressionToken[] {
  const tokens: TagExpressionToken[] = [];
  let buffer = '';
  let index = 0;

  const pushTag = () => {
    const tag = resolveTagAlias(buffer);
    if (tag) tokens.push({ type: 'tag', value: tag });
    buffer = '';
  };

  while (index < expression.length) {
    const char = expression[index];
    if (char === '(' || char === ')' || char === ',') {
      pushTag();
      tokens.push({ type: char === '(' ? 'open' : char === ')' ? 'close' : 'and' });
      index += 1;
      continue;
    }

    const operator = readTagOperator(expression, index);
    if (operator) {
      pushTag();
      tokens.push({ type: operator });
      index += operator.length;
      continue;
    }

    buffer += char;
    index += 1;
  }

  pushTag();
  return tokens;
}

function readTagOperator(expression: string, index: number): 'and' | 'or' | undefined {
  const rest = expression.slice(index);
  const match = /^(and|or)\b/i.exec(rest);
  if (!match) return undefined;
  const before = index === 0 ? '' : expression[index - 1];
  if (before && !/\s|\(/.test(before)) return undefined;
  const after = expression[index + match[1].length] ?? '';
  if (after && !/\s|\)/.test(after)) return undefined;
  return match[1].toLowerCase() as 'and' | 'or';
}

function evaluateTagExpression(expression: TagExpressionNode, itemTags: string[]): boolean {
  if (expression.type === 'tag') return itemTags.some((itemTag) => tagMatchesFilter(expression.value, itemTag));
  if (expression.type === 'and') return evaluateTagExpression(expression.left, itemTags) && evaluateTagExpression(expression.right, itemTags);
  return evaluateTagExpression(expression.left, itemTags) || evaluateTagExpression(expression.right, itemTags);
}

function canonicalizeRequestedTags(tags: string[], catalogTags: string[], tagAliases: Record<string, string[]> = {}): string[] {
  const knownTags = knownTagPaths(catalogTags);
  return Array.from(new Set(tags.map((tag) => resolveKnownTagPath(resolveTagAliasFromMap(tag, tagAliases), knownTags)).filter(Boolean)));
}

function knownTagPaths(catalogTags: string[]): string[] {
  return Array.from(
    new Set(
      [
        ...cachedTagCatalog,
        ...catalogTags,
        ...cachedFiles.flatMap((item) => expandTagPathAncestors(item.tags.map(resolveTagAlias))),
      ]
        .map(normalizeTag)
        .filter(Boolean),
    ),
  );
}

export function resolveKnownTagPath(tag: string, knownTags: string[]): string {
  const normalized = normalizeTag(tag);
  if (!normalized) return '';
  if (normalized.includes('/')) return normalized;

  const hierarchicalLeafMatches = knownTags.filter(
    (knownTag) => knownTag.includes('/') && knownTag.split('/').at(-1) === normalized,
  );
  const uniqueHierarchicalLeafMatches = Array.from(
    new Map(hierarchicalLeafMatches.map((knownTag) => [knownTag, knownTag])).values(),
  );
  if (uniqueHierarchicalLeafMatches.length === 1) return uniqueHierarchicalLeafMatches[0];

  const exact = knownTags.find((knownTag) => knownTag === normalized);
  if (exact) return exact;

  const leafMatches = knownTags.filter((knownTag) => knownTag.split('/').at(-1) === normalized);
  const uniqueLeafMatches = Array.from(new Map(leafMatches.map((knownTag) => [knownTag, knownTag])).values());
  return uniqueLeafMatches.length === 1 ? uniqueLeafMatches[0] : normalized;
}

function replaceTagPath(tag: string, from: string, to: string): string {
  const normalizedTag = normalizeTag(tag);
  const normalizedFrom = normalizeTag(from);
  const normalizedTo = normalizeTag(to);
  if (normalizedTag === normalizedFrom) return normalizedTo;
  if (normalizedTag.startsWith(`${normalizedFrom}/`)) {
    return `${normalizedTo}${normalizedTag.slice(normalizedFrom.length)}`;
  }
  return normalizedTag;
}

function expandTagAncestors(tags: string[]): string[] {
  const expanded = new Set<string>();
  for (const tag of tags.map(normalizeTag).filter(Boolean)) {
    const parts = tag.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      expanded.add(parts.slice(0, index + 1).join('/'));
      expanded.add(parts[index]);
    }
  }
  return Array.from(expanded);
}

function expandTagPathAncestors(tags: string[]): string[] {
  const expanded = new Set<string>();
  for (const tag of tags.map(normalizeTag).filter(Boolean)) {
    const parts = tag.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      expanded.add(parts.slice(0, index + 1).join('/'));
    }
  }
  return Array.from(expanded);
}

function descendantsOfTag(filter: string): string[] {
  const normalizedFilter = normalizeTag(filter);
  return cachedTagCatalog
    .map(normalizeTag)
    .filter(Boolean)
    .filter((tag) => tag === normalizedFilter || tag.startsWith(`${normalizedFilter}/`) || tag.split('/').includes(normalizedFilter));
}

function cacheTagAliases(tagAliases: Record<string, string[]> = {}) {
  cachedAliasCanonical = new Map<string, string>();
  cachedCanonicalAliases = new Map<string, Set<string>>();
  for (const [tag, aliases] of Object.entries(tagAliases)) {
    const canonical = normalizeTag(tag);
    if (!canonical) continue;
    const members = new Set([canonical, ...aliases.map(normalizeTag).filter(Boolean)]);
    cachedCanonicalAliases.set(canonical, members);
    for (const member of members) {
      cachedAliasCanonical.set(member, canonical);
    }
  }
}

function equivalentTags(tag: string): string[] {
  const normalized = normalizeTag(tag);
  const canonical = cachedAliasCanonical.get(normalized) ?? normalized;
  return Array.from(cachedCanonicalAliases.get(canonical) ?? new Set([canonical]));
}

export function resolveTagAliasFromMap(tag: string, tagAliases: Record<string, string[]>): string {
  const normalized = normalizeTag(tag);
  for (const [canonical, aliases] of Object.entries(tagAliases)) {
    const cleanCanonical = normalizeTag(canonical);
    if (!cleanCanonical) continue;
    const members = [cleanCanonical, ...aliases.map(normalizeTag).filter(Boolean)];
    if (members.includes(normalized)) return cleanCanonical;
  }
  return normalized;
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
