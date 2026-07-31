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
  TagUpdateMode,
  TagUpdateRequest,
} from '../shared/types.js';

/**
 * Exported error type for validation failures.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Utility helpers
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return false;
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  // Accept objects with Object.prototype or null prototype (e.g., Express query objects)
  if (proto !== Object.prototype && proto !== null) return false;
  return true;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Reject unsafe keys (prototype pollution).
 */
function rejectUnsafeKeys(obj: Record<string, unknown>): void {
  const unsafe = ['__proto__', 'prototype', 'constructor'];
  for (const key of Object.keys(obj)) {
    if (unsafe.includes(key)) throw new ValidationError(`Unsafe key: ${key}`);
  }
  // Also check own property names that may not be enumerable
  for (const key of unsafe) {
    if (Object.hasOwn(obj, key)) throw new ValidationError(`Unsafe own property: ${key}`);
  }
}

/**
 * Ensure value is a non-null non-array object.
 */
function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValidationError(`${label} must be a non-null non-array object`);
  rejectUnsafeKeys(value);
  return value;
}

/**
 * Ensure value is an array of strings.
 */
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${label} must be an array`);
  for (const item of value) {
    if (!isString(item)) throw new ValidationError(`${label} items must be strings`);
  }
  return value.map(String);
}

// ---- Validators for request DTOs ----

export function validateAppSettings(input: unknown): AppSettings {
  const obj = requireObject(input, 'AppSettings');
  const libraries = obj.libraries;
  if (!Array.isArray(libraries)) throw new ValidationError('libraries must be an array');
  for (const lib of libraries) {
    if (!isPlainObject(lib)) throw new ValidationError('each library must be an object');
    rejectUnsafeKeys(lib);
    if (!isString(lib.id)) throw new ValidationError('library.id must be a string');
    if (!isString(lib.name)) throw new ValidationError('library.name must be a string');
    if (!isString(lib.path)) throw new ValidationError('library.path must be a string');
    if (!isBoolean(lib.enabled ?? true)) throw new ValidationError('library.enabled must be a boolean');
    if (!isBoolean(lib.startExpanded ?? true)) throw new ValidationError('library.startExpanded must be a boolean');
  }
  const tagCatalog = obj.tagCatalog;
  if (!Array.isArray(tagCatalog)) throw new ValidationError('tagCatalog must be an array');
  for (const tag of tagCatalog) {
    if (!isString(tag)) throw new ValidationError('tagCatalog items must be strings');
  }
  const tagAliases = obj.tagAliases;
  if (tagAliases !== undefined && !isPlainObject(tagAliases)) throw new ValidationError('tagAliases must be an object');
  if (tagAliases) {
    rejectUnsafeKeys(tagAliases);
    for (const [tag, aliases] of Object.entries(tagAliases)) {
      if (!Array.isArray(aliases)) throw new ValidationError('tagAliases values must be arrays');
      for (const alias of aliases) {
        if (!isString(alias)) throw new ValidationError('tagAliases alias items must be strings');
      }
    }
  }
  return {
    libraries: libraries.map((lib) => ({
      id: String(lib.id),
      name: String(lib.name),
      path: String(lib.path),
      enabled: lib.enabled !== false,
      startExpanded: lib.startExpanded !== false,
    })),
    tagCatalog: tagCatalog.map(String),
    tagAliases: tagAliases
      ? Object.fromEntries(
          Object.entries(tagAliases).map(([tag, aliases]) => {
            if (!Array.isArray(aliases)) return [tag, [] as string[]];
            return [tag, aliases.map(String)];
          }),
        )
      : {},
  };
}

export function validateTagUpdateRequest(input: unknown): TagUpdateRequest {
  const obj = requireObject(input, 'TagUpdateRequest');
  const ids = obj.ids;
  if (!Array.isArray(ids)) throw new ValidationError('ids must be an array');
  for (const id of ids) {
    if (!isString(id)) throw new ValidationError('ids items must be strings');
  }
  if (ids.length === 0) throw new ValidationError('At least one media item is required.');
  const tags = obj.tags;
  if (!Array.isArray(tags)) throw new ValidationError('tags must be an array');
  for (const tag of tags) {
    if (!isString(tag)) throw new ValidationError('tags items must be strings');
  }
  const mode = obj.mode;
  if (!isString(mode)) throw new ValidationError('mode must be a string');
  if (!['replace', 'add', 'remove'].includes(mode)) throw new ValidationError('mode must be replace/add/remove');
  const description = obj.description;
  if (description !== undefined && !isString(description)) throw new ValidationError('description must be a string if present');
  return { ids: ids.map(String), tags: tags.map(String), mode: mode as TagUpdateMode, description };
}

export function validateTagCatalogUpdateRequest(input: unknown): TagCatalogUpdateRequest {
  const obj = requireObject(input, 'TagCatalogUpdateRequest');
  const tags = obj.tags;
  if (!Array.isArray(tags)) throw new ValidationError('tags must be an array');
  for (const tag of tags) {
    if (!isString(tag)) throw new ValidationError('tags items must be strings');
  }
  return { tags: tags.map(String) };
}

export function validateTagAliasUpdateRequest(input: unknown): TagAliasUpdateRequest {
  const obj = requireObject(input, 'TagAliasUpdateRequest');
  const tag = obj.tag;
  if (!isString(tag)) throw new ValidationError('tag must be a string');
  const aliases = obj.aliases;
  if (!Array.isArray(aliases)) throw new ValidationError('aliases must be an array');
  for (const alias of aliases) {
    if (!isString(alias)) throw new ValidationError('aliases items must be strings');
  }
  return { tag: String(tag), aliases: aliases.map(String) };
}

export function validateRenameTagRequest(input: unknown): RenameTagRequest {
  const obj = requireObject(input, 'RenameTagRequest');
  const from = obj.from;
  if (!isString(from)) throw new ValidationError('from must be a string');
  const to = obj.to;
  if (!isString(to)) throw new ValidationError('to must be a string');
  return { from: String(from), to: String(to) };
}

export function validateCreateFolderRequest(input: unknown): CreateFolderRequest {
  const obj = requireObject(input, 'CreateFolderRequest');
  const libraryId = obj.libraryId;
  if (!isString(libraryId)) throw new ValidationError('libraryId must be a string');
  const parentPath = obj.parentPath;
  if (parentPath !== undefined && !isString(parentPath)) throw new ValidationError('parentPath must be a string if present');
  const name = obj.name;
  if (!isString(name)) throw new ValidationError('name must be a string');
  return { libraryId: String(libraryId), parentPath: parentPath ? String(parentPath) : undefined, name: String(name) };
}

export function validateMoveMediaRequest(input: unknown): MoveMediaRequest {
  const obj = requireObject(input, 'MoveMediaRequest');
  const ids = obj.ids;
  if (!Array.isArray(ids)) throw new ValidationError('ids must be an array');
  for (const id of ids) {
    if (!isString(id)) throw new ValidationError('ids items must be strings');
  }
  if (ids.length === 0) throw new ValidationError('At least one media item is required.');
  const libraryId = obj.libraryId;
  if (!isString(libraryId)) throw new ValidationError('libraryId must be a string');
  const targetPath = obj.targetPath;
  if (targetPath !== undefined && !isString(targetPath)) throw new ValidationError('targetPath must be a string if present');
  return { ids: ids.map(String), libraryId: String(libraryId), targetPath: targetPath ? String(targetPath) : undefined };
}

export function validateMoveFolderRequest(input: unknown): MoveFolderRequest {
  const obj = requireObject(input, 'MoveFolderRequest');
  const libraryId = obj.libraryId;
  if (!isString(libraryId) || libraryId === '') throw new ValidationError('libraryId must be a non-empty string');
  const sourcePath = obj.sourcePath;
  if (!isString(sourcePath) || sourcePath === '') throw new ValidationError('sourcePath must be a non-empty string');
  const targetLibraryId = obj.targetLibraryId;
  if (!isString(targetLibraryId) || targetLibraryId === '') throw new ValidationError('targetLibraryId must be a non-empty string');
  const targetPath = obj.targetPath;
  if (targetPath !== undefined && !isString(targetPath)) throw new ValidationError('targetPath must be a string if present');
  return {
    libraryId: String(libraryId),
    sourcePath: String(sourcePath),
    targetLibraryId: String(targetLibraryId),
    targetPath: targetPath ? String(targetPath) : undefined,
  };
}

export function validateDeleteMediaRequest(input: unknown): DeleteMediaRequest {
  const obj = requireObject(input, 'DeleteMediaRequest');
  const ids = obj.ids;
  if (!Array.isArray(ids)) throw new ValidationError('ids must be an array');
  for (const id of ids) {
    if (!isString(id)) throw new ValidationError('ids items must be strings');
  }
  if (ids.length === 0) throw new ValidationError('At least one media item is required.');
  return { ids: ids.map(String) };
}

// ---- Scalar/query/multipart validators ----

export function validateDeleteTagsQuery(input: unknown): { tag: string } {
  // query parameter `tag` - if missing or undefined, default to empty string
  if (input === undefined || input === null) {
    return { tag: '' };
  }
  // Accept arrays (Express may send multiple values) and join
  if (Array.isArray(input)) {
    return { tag: input.filter(Boolean).join(',') };
  }
  if (!isString(input)) throw new ValidationError('tag query parameter must be a string');
  return { tag: String(input) };
}

function coerceStringOrArray(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  // Treat arrays as absent (compatibility with old route behavior).
  if (Array.isArray(value)) return undefined;
  if (isString(value)) return String(value);
  return undefined;
}

export function validateMediaQuery(input: unknown): MediaQuery {
  // q, folder, libraryId are optional strings
  // tags and tagExpression are handled in the route from the string tags param
  if (!isPlainObject(input)) throw new ValidationError('MediaQuery must be a non-null non-array object');
  rejectUnsafeKeys(input);
  const q = coerceStringOrArray(input.q);
  const tags = coerceStringOrArray(input.tags);
  const folder = coerceStringOrArray(input.folder);
  const libraryId = coerceStringOrArray(input.libraryId);
  // tagExpression is derived from tags string in the route; we keep it as a copy
  return {
    q,
    tags: undefined, // will be computed from tagExpression in route handler
    tagExpression: tags, // raw string
    folder,
    libraryId,
  };
}

export function validateDownloadQuery(input: unknown): { ids: string[] } {
  if (input === undefined || input === null) {
    return { ids: [] };
  }
  // For non-string values including arrays, return no IDs (old route behavior).
  if (!isString(input)) {
    return { ids: [] };
  }
  return { ids: String(input).split(',').filter(Boolean) };
}

export function validateUploadMultipart(input: unknown): { libraryId: string; targetPath?: string } {
  if (!isPlainObject(input)) throw new ValidationError('Upload body must be a non-null non-array object');
  rejectUnsafeKeys(input);
  const libraryId = input.libraryId;
  if (!isString(libraryId)) throw new ValidationError('libraryId must be a string');
  const targetPath = input.targetPath;
  if (targetPath !== undefined && !isString(targetPath)) throw new ValidationError('targetPath must be a string if present');
  return { libraryId: String(libraryId), targetPath: targetPath ? String(targetPath) : undefined };
}
