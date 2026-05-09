export type MediaKind = 'image' | 'video';

export type ViewMode = 'list' | 'grid' | 'masonry-vertical' | 'masonry-horizontal' | 'calendar';

export type LibrarySettings = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
};

export type AppSettings = {
  libraries: LibrarySettings[];
  tagCatalog: string[];
};

export type RuntimeConfig = {
  version: string;
  readOnly: boolean;
  blacklistedTags: string[];
  hideEmptyFolders: boolean;
  maxUploadMb: number;
  defaultReadOnlyView: ViewMode;
  backupIntervalHours: number;
  backupRetentionDays: number;
};

export type IndexStatus = {
  isScanning: boolean;
  phase: string;
  filesSeen: number;
  filesIndexed: number;
  totalFiles: number;
  currentPath: string;
  startedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
};

export type MediaItem = {
  id: string;
  libraryId: string;
  libraryName: string;
  relativePath: string;
  folder: string;
  name: string;
  extension: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  createdAt: string;
  modifiedAt: string;
  indexedAt: string;
  tags: string[];
  description: string;
  artist: string;
  thumbnailUrl: string;
  previewThumbnailUrl: string;
  fileUrl: string;
};

export type PagedMediaResponse = {
  items: MediaItem[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
};

export type FolderNode = {
  id: string;
  libraryId: string;
  name: string;
  relativePath: string;
  depth: number;
  itemCount: number;
  children: FolderNode[];
};

export type TagSummary = {
  tag: string;
  count: number;
};

export type MediaQuery = {
  q?: string;
  tags?: string[];
  tagExpression?: string;
  folder?: string;
  libraryId?: string;
};

export type TagUpdateMode = 'replace' | 'add' | 'remove';

export type TagUpdateRequest = {
  ids: string[];
  tags: string[];
  mode: TagUpdateMode;
  description?: string;
};

export type CreateFolderRequest = {
  libraryId: string;
  parentPath?: string;
  name: string;
};

export type MoveMediaRequest = {
  ids: string[];
  libraryId: string;
  targetPath?: string;
};

export type DeleteMediaRequest = {
  ids: string[];
};

export type TagCatalogUpdateRequest = {
  tags: string[];
};

export type RenameTagRequest = {
  from: string;
  to: string;
};

export type ApiEnvelope<T> = {
  data: T;
};

export type ApiError = {
  error: string;
};
