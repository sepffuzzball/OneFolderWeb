import { describe, expect, it } from 'vitest';
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

describe('validation', () => {
  describe('validateAppSettings', () => {
    it('rejects null', () => {
      expect(() => validateAppSettings(null)).toThrow(ValidationError);
    });
    it('rejects non-object', () => {
      expect(() => validateAppSettings('hello')).toThrow(ValidationError);
    });
    it('rejects array', () => {
      expect(() => validateAppSettings([])).toThrow(ValidationError);
    });
    it('accepts valid settings', () => {
      expect(() =>
        validateAppSettings({
          libraries: [{ id: 'lib1', name: 'Lib', path: '/path', enabled: true, startExpanded: false }],
          tagCatalog: ['tag1'],
          tagAliases: { tag1: ['alias1'] },
        }),
      ).not.toThrow();
    });
    it('rejects unsafe keys in libraries', () => {
      expect(() =>
        validateAppSettings({
          libraries: [{ id: 'lib1', name: 'Lib', path: '/path', __proto__: { enabled: true } }],
          tagCatalog: [],
          tagAliases: {},
        }),
      ).toThrow(ValidationError);
    });
  });

  describe('validateTagUpdateRequest', () => {
    it('rejects missing ids', () => {
      expect(() => validateTagUpdateRequest({ ids: [], tags: ['t1'], mode: 'add' })).toThrow('At least one media item');
    });
    it('accepts valid request', () => {
      expect(() => validateTagUpdateRequest({ ids: ['id1'], tags: ['t1'], mode: 'add' })).not.toThrow();
    });
    it('rejects invalid mode', () => {
      expect(() => validateTagUpdateRequest({ ids: ['id1'], tags: ['t1'], mode: 'bad' })).toThrow(ValidationError);
    });
    it('rejects non-array ids', () => {
      expect(() => validateTagUpdateRequest({ ids: 'id1', tags: ['t1'], mode: 'add' })).toThrow(ValidationError);
    });
    it('rejects non-string ids', () => {
      expect(() => validateTagUpdateRequest({ ids: [1], tags: ['t1'], mode: 'add' })).toThrow(ValidationError);
    });
  });

  describe('validateTagCatalogUpdateRequest', () => {
    it('accepts valid catalog', () => {
      expect(() => validateTagCatalogUpdateRequest({ tags: ['t1'] })).not.toThrow();
    });
    it('rejects non-array tags', () => {
      expect(() => validateTagCatalogUpdateRequest({ tags: 't1' })).toThrow(ValidationError);
    });
  });

  describe('validateTagAliasUpdateRequest', () => {
    it('accepts valid aliases', () => {
      expect(() => validateTagAliasUpdateRequest({ tag: 't1', aliases: ['a1'] })).not.toThrow();
    });
    it('rejects non-string tag', () => {
      expect(() => validateTagAliasUpdateRequest({ tag: 1, aliases: ['a1'] })).toThrow(ValidationError);
    });
  });

  describe('validateRenameTagRequest', () => {
    it('accepts valid rename', () => {
      expect(() => validateRenameTagRequest({ from: 'old', to: 'new' })).not.toThrow();
    });
    it('rejects missing from', () => {
      expect(() => validateRenameTagRequest({ to: 'new' })).toThrow(ValidationError);
    });
  });

  describe('validateCreateFolderRequest', () => {
    it('accepts valid folder creation', () => {
      expect(() => validateCreateFolderRequest({ libraryId: 'lib', name: 'folder' })).not.toThrow();
    });
    it('rejects missing libraryId', () => {
      expect(() => validateCreateFolderRequest({ name: 'folder' })).toThrow(ValidationError);
    });
  });

  describe('validateMoveMediaRequest', () => {
    it('rejects empty ids', () => {
      expect(() => validateMoveMediaRequest({ ids: [], libraryId: 'lib' })).toThrow('At least one media item');
    });
    it('accepts valid request', () => {
      expect(() => validateMoveMediaRequest({ ids: ['id1'], libraryId: 'lib' })).not.toThrow();
    });
  });

  describe('validateMoveFolderRequest', () => {
    it('rejects missing sourcePath', () => {
      expect(() => validateMoveFolderRequest({ libraryId: 'lib', sourcePath: '', targetLibraryId: 'lib' })).toThrow(ValidationError);
    });
    it('accepts valid request', () => {
      expect(() => validateMoveFolderRequest({ libraryId: 'lib', sourcePath: '/src', targetLibraryId: 'lib' })).not.toThrow();
    });
  });

  describe('validateDeleteMediaRequest', () => {
    it('rejects empty ids', () => {
      expect(() => validateDeleteMediaRequest({ ids: [] })).toThrow('At least one media item');
    });
    it('accepts valid request', () => {
      expect(() => validateDeleteMediaRequest({ ids: ['id1'] })).not.toThrow();
    });
  });

  describe('validateDeleteTagsQuery', () => {
    it('accepts string', () => {
      expect(() => validateDeleteTagsQuery('tag1')).not.toThrow();
    });
    it('rejects number', () => {
      expect(() => validateDeleteTagsQuery(1)).toThrow(ValidationError);
    });
  });

  describe('validateMediaQuery', () => {
    it('accepts empty object', () => {
      expect(() => validateMediaQuery({})).not.toThrow();
    });
    it('rejects non-object', () => {
      expect(() => validateMediaQuery('str')).toThrow(ValidationError);
    });
    it('accepts query with q', () => {
      expect(() => validateMediaQuery({ q: 'hello' })).not.toThrow();
    });
    it('rejects unsafe keys', () => {
      expect(() => validateMediaQuery({ __proto__: {} })).toThrow(ValidationError);
    });
    it('treats array q as absent', () => {
      const result = validateMediaQuery({ q: ['a', 'b'] });
      expect(result.q).toBeUndefined();
    });
    it('treats array tags as absent', () => {
      const result = validateMediaQuery({ tags: ['t1', 't2'] });
      expect(result.tagExpression).toBeUndefined();
    });
    it('treats array folder as absent', () => {
      const result = validateMediaQuery({ folder: ['f1', 'f2'] });
      expect(result.folder).toBeUndefined();
    });
    it('treats array libraryId as absent', () => {
      const result = validateMediaQuery({ libraryId: ['lib1', 'lib2'] });
      expect(result.libraryId).toBeUndefined();
    });
  });

  describe('validateDownloadQuery', () => {
    it('accepts string of comma-separated ids', () => {
      expect(() => validateDownloadQuery('id1,id2')).not.toThrow();
    });
    it('accepts single id', () => {
      expect(() => validateDownloadQuery('id1')).not.toThrow();
    });
    it('returns empty ids for array input (old route behavior)', () => {
      const result = validateDownloadQuery(['id1', 'id2']);
      expect(result.ids).toEqual([]);
    });
    it('returns empty ids for number input', () => {
      const result = validateDownloadQuery(123);
      expect(result.ids).toEqual([]);
    });
  });

  describe('validateUploadMultipart', () => {
    it('accepts valid body', () => {
      expect(() => validateUploadMultipart({ libraryId: 'lib' })).not.toThrow();
    });
    it('rejects missing libraryId', () => {
      expect(() => validateUploadMultipart({})).toThrow(ValidationError);
    });
    it('rejects non-object', () => {
      expect(() => validateUploadMultipart('str')).toThrow(ValidationError);
    });
  });
});
