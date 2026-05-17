import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clipboard,
  Copy,
  Download,
  File as FileIcon,
  FileText,
  FolderPlus,
  Grid2X2,
  Image as ImageIcon,
  LayoutList,
  Link,
  Pencil,
  Play,
  Plus,
  Rows3,
  Search,
  Settings,
  Shield,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Tags,
  Trash2,
  Upload,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { AppSettings, FolderNode, IndexStatus, MediaItem, PagedMediaResponse, RuntimeConfig, TagSummary, ViewMode } from '../shared/types.js';

type Toast = { id: number; message: string };
type SidebarTab = 'libraries' | 'tags';
type TagSortMode = 'alpha' | 'count';
type BrowseOrderMode = 'linear' | 'shuffle';
type ExportAspect = 'original' | '16:9' | '16:10' | '1:1';
type CropRect = { x: number; y: number; width: number; height: number };
type CropHandle = 'nw' | 'ne' | 'sw' | 'se';
type DetailFitMode = 'contain' | 'cover';
type Size = { width: number; height: number };
type DraggedFolder = { libraryId: string; path: string };
const MEDIA_PAGE_SIZE = 240;

const viewOptions: Array<{ id: ViewMode; label: string; icon: typeof Grid2X2 }> = [
  { id: 'grid', label: 'Grid', icon: Grid2X2 },
  { id: 'masonry-vertical', label: 'Vertical masonry', icon: Rows3 },
  { id: 'masonry-horizontal', label: 'Horizontal masonry', icon: ImageIcon },
  { id: 'list', label: 'List', icon: LayoutList },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
];

export function App() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null);
  const [isLoadingLibrary, setLoadingLibrary] = useState(false);
  const [isPrefetchingMedia, setPrefetchingMedia] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [mediaTotal, setMediaTotal] = useState(0);
  const [knownTags, setKnownTags] = useState<string[]>([]);
  const [tagSummaries, setTagSummaries] = useState<TagSummary[]>([]);
  const [tree, setTree] = useState<FolderNode[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('grid');
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [folderFilter, setFolderFilter] = useState<{ libraryId?: string; folder?: string }>({});
  const [tagDraft, setTagDraft] = useState('');
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const [folderDraft, setFolderDraft] = useState('');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('libraries');
  const [tagSort, setTagSort] = useState<TagSortMode>('alpha');
  const [browseOrder, setBrowseOrder] = useState<BrowseOrderMode>('linear');
  const [shuffleIds, setShuffleIds] = useState<string[]>([]);
  const [slideshowOpen, setSlideshowOpen] = useState(false);
  const [slideshowSeconds, setSlideshowSeconds] = useState(7);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [isDragging, setDragging] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const selectionAnchorId = useRef<string | null>(null);
  const loadedLimitRef = useRef(MEDIA_PAGE_SIZE);
  const prefetchInFlightRef = useRef(false);
  const defaultReadOnlyViewAppliedRef = useRef(false);

  const activeItem = useMemo(() => items.find((item) => item.id === activeId) ?? null, [activeId, items]);
  const selectedItems = useMemo(() => items.filter((item) => selectedIds.includes(item.id)), [items, selectedIds]);
  const debouncedQuery = useDebouncedValue(query, 180);
  const debouncedTagFilter = useDebouncedValue(tagFilter, 180);
  const managedTags = useMemo(
    () =>
      Array.from(
        new Set(
          [...(settings?.tagCatalog ?? []), ...knownTags, ...items.flatMap((item) => expandTagPathAncestors(item.tags))]
            .map((tag) => resolveTagAlias(tag, settings?.tagAliases ?? {}))
            .filter(Boolean),
        ),
      ).sort((a, b) => a.localeCompare(b)),
    [items, knownTags, settings?.tagAliases, settings?.tagCatalog],
  );
  const allTags = useMemo(
    () =>
      Array.from(new Set([...managedTags, ...Object.values(settings?.tagAliases ?? {}).flat().map(normalizeTag).filter(Boolean)])).sort((a, b) =>
        a.localeCompare(b),
      ),
    [managedTags, settings?.tagAliases],
  );
  const orderedItems = useMemo(() => (browseOrder === 'shuffle' ? orderItemsByIds(items, shuffleIds) : items), [browseOrder, items, shuffleIds]);
  const slideshowItems = useMemo(() => orderedItems.filter(isSlideshowItem), [orderedItems]);

  const notify = useCallback((message: string) => {
    const id = Date.now();
    setToasts((current) => [...current, { id, message }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 3200);
  }, []);

  useEffect(() => {
    if (!config) return;
    document.title = config.siteName;
    updateFavicon(config.siteImageUrl);
  }, [config]);

  const buildMediaParams = useCallback(
    (offset: number, limit: number) => {
      const params = new URLSearchParams();
      if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
      if (debouncedTagFilter.trim()) params.set('tags', debouncedTagFilter.split(',').map((tag) => tag.trim()).filter(Boolean).join(','));
      if (folderFilter.folder) params.set('folder', folderFilter.folder);
      if (folderFilter.libraryId) params.set('libraryId', folderFilter.libraryId);
      params.set('offset', String(offset));
      params.set('limit', String(limit));
      return params;
    },
    [debouncedQuery, debouncedTagFilter, folderFilter.folder, folderFilter.libraryId],
  );

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    buildMediaParams(0, loadedLimitRef.current).forEach((value, key) => params.set(key, value));
    setLoadingLibrary(true);
    try {
      const [configResponse, settingsResponse, statusResponse, tagsResponse, tagSummaryResponse, mediaResponse, treeResponse] = await Promise.all([
        api<RuntimeConfig>('/api/config'),
        api<AppSettings>('/api/settings'),
        api<IndexStatus>('/api/status'),
        api<string[]>('/api/tags'),
        api<TagSummary[]>('/api/tags/summary'),
        api<PagedMediaResponse>(`/api/media?${params}`),
        api<FolderNode[]>('/api/tree'),
      ]);
      setConfig(configResponse);
      if (configResponse.readOnly && !defaultReadOnlyViewAppliedRef.current) {
        setView(configResponse.defaultReadOnlyView);
        defaultReadOnlyViewAppliedRef.current = true;
      }
      setSettings(settingsResponse);
      setIndexStatus(statusResponse);
      setKnownTags(tagsResponse);
      setTagSummaries(tagSummaryResponse);
      setItems(mediaResponse.items);
      setMediaTotal(mediaResponse.total);
      setTree(treeResponse);
      setSelectedIds((ids) => ids.filter((id) => mediaResponse.items.some((item) => item.id === id)));
    } finally {
      setLoadingLibrary(false);
    }
  }, [buildMediaParams]);

  useEffect(() => {
    loadedLimitRef.current = MEDIA_PAGE_SIZE;
  }, [folderFilter.folder, folderFilter.libraryId, debouncedQuery, debouncedTagFilter]);

  useEffect(() => {
    if (browseOrder !== 'shuffle') return;
    setShuffleIds((ids) => reconcileShuffleIds(ids, items.map((item) => item.id)));
  }, [browseOrder, items]);

  const prefetchMoreMedia = useCallback(async () => {
    if (prefetchInFlightRef.current || isLoadingLibrary || items.length >= mediaTotal) return;
    prefetchInFlightRef.current = true;
    setPrefetchingMedia(true);
    try {
      const response = await api<PagedMediaResponse>(`/api/media?${buildMediaParams(items.length, MEDIA_PAGE_SIZE)}`);
      const existingIds = new Set(items.map((item) => item.id));
      const nextItems = [...items, ...response.items.filter((item) => !existingIds.has(item.id))];
      loadedLimitRef.current = Math.max(MEDIA_PAGE_SIZE, nextItems.length);
      setItems(nextItems);
      setMediaTotal(response.total);
    } finally {
      prefetchInFlightRef.current = false;
      setPrefetchingMedia(false);
    }
  }, [buildMediaParams, isLoadingLibrary, items, mediaTotal]);

  const navigateActiveItem = useCallback(
    (direction: -1 | 1) => {
      if (!activeId) return;
      const currentIndex = orderedItems.findIndex((item) => item.id === activeId);
      if (currentIndex === -1) return;
      const nextItem = orderedItems[currentIndex + direction];
      if (!nextItem) return;
      selectionAnchorId.current = nextItem.id;
      setSelectedIds([nextItem.id]);
      setDescriptionDraft(nextItem.description);
      setTagDraft('');
      setActiveId(nextItem.id);
      if (direction > 0 && items.length < mediaTotal && currentIndex >= orderedItems.length - 3) void prefetchMoreMedia();
    },
    [activeId, items.length, mediaTotal, orderedItems, prefetchMoreMedia],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      const status = await api<IndexStatus>('/api/status');
      setIndexStatus(status);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && activeId) {
        event.preventDefault();
        setActiveId(null);
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (activeId && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        navigateActiveItem(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (event.key === 'Enter' && selectedIds.length === 1 && !activeId) {
        event.preventDefault();
        setActiveId(selectedIds[0]);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selectedIds.length > 0) {
        event.preventDefault();
        void copySelectedFiles();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeId, navigateActiveItem, selectedIds]);

  const selectItem = (item: MediaItem, event?: React.MouseEvent) => {
    setActiveId(null);
    setDescriptionDraft(item.description);
    if (event?.shiftKey && selectionAnchorId.current) {
      const anchorIndex = orderedItems.findIndex((candidate) => candidate.id === selectionAnchorId.current);
      const itemIndex = orderedItems.findIndex((candidate) => candidate.id === item.id);
      if (anchorIndex !== -1 && itemIndex !== -1) {
        const [start, end] = [anchorIndex, itemIndex].sort((a, b) => a - b);
        setSelectedIds(orderedItems.slice(start, end + 1).map((candidate) => candidate.id));
        return;
      }
    }

    selectionAnchorId.current = item.id;
    if (event?.ctrlKey || event?.metaKey) {
      setSelectedIds((ids) => (ids.includes(item.id) ? ids.filter((id) => id !== item.id) : [...ids, item.id]));
    } else {
      setSelectedIds([item.id]);
    }
  };

  const openItem = (item: MediaItem) => {
    setSelectedIds([item.id]);
    setDescriptionDraft(item.description);
    setTagDraft('');
    setActiveId(item.id);
  };

  const shuffleCurrentItems = () => {
    setShuffleIds(shuffleArray(items.map((item) => item.id)));
    setBrowseOrder('shuffle');
  };

  const startSlideshow = () => {
    if (slideshowItems.length === 0) {
      notify('No images or videos in the current view');
      return;
    }
    setActiveId(null);
    setSlideshowOpen(true);
    if (items.length < mediaTotal && slideshowItems.length < 3) void prefetchMoreMedia();
  };
  const closeSlideshow = useCallback(() => setSlideshowOpen(false), []);

  const clearSelection = () => {
    selectionAnchorId.current = null;
    setSelectedIds([]);
    setActiveId(null);
  };

  const applyTags = async (mode: 'replace' | 'add' | 'remove') => {
    if (selectedIds.length === 0) return;
    const tags = tagDraft.split(',').map((tag) => tag.trim()).filter(Boolean);
    await api('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ ids: selectedIds, tags, mode, description: descriptionDraft || undefined }),
    });
    setTagDraft('');
    notify('Metadata saved to XMP');
    await load();
  };

  const applyTagToSelection = async (tag: string, mode: 'add' | 'remove' = 'add') => {
    if (selectedIds.length === 0) return;
    await api('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ ids: selectedIds, tags: [tag], mode }),
    });
    notify(mode === 'add' ? 'Tag applied' : 'Tag removed');
    await load();
  };

  const removeTagFromItem = async (id: string, tag: string) => {
    if (config?.readOnly) return;
    await api('/api/tags', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], tags: [tag], mode: 'remove' }),
    });
    notify('Tag removed');
    await load();
  };

  const createFolder = async () => {
    const libraryId = folderFilter.libraryId ?? settings?.libraries[0]?.id;
    if (!libraryId || !folderDraft.trim()) return;
    await api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ libraryId, parentPath: folderFilter.folder, name: folderDraft.trim() }),
    });
    setFolderDraft('');
    notify('Folder created');
    await load();
  };

  const uploadFiles = useCallback(async (files: FileList | File[], successMessage = 'Upload complete') => {
    const libraryId = folderFilter.libraryId ?? settings?.libraries[0]?.id;
    if (!libraryId || files.length === 0) return;
    const body = new FormData();
    body.set('libraryId', libraryId);
    body.set('targetPath', folderFilter.folder ?? '');
    Array.from(files).forEach((file) => body.append('files', file));
    await api('/api/upload', { method: 'POST', body });
    notify(successMessage);
    await load();
  }, [folderFilter.folder, folderFilter.libraryId, load, notify, settings?.libraries]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (config?.readOnly) return;
      const pastedImages = clipboardImageFiles(event.clipboardData);
      if (pastedImages.length === 0) return;
      event.preventDefault();
      const successMessage = pastedImages.length === 1 ? 'Pasted image into folder' : `${pastedImages.length} images pasted into folder`;
      void uploadFiles(pastedImages, successMessage).catch((error) => {
        console.error(error);
        notify('Could not paste image');
      });
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [config?.readOnly, notify, uploadFiles]);

  const moveItems = async (ids: string[], target: { libraryId: string; folder?: string }) => {
    if (ids.length === 0 || config?.readOnly) return;
    await api('/api/move', {
      method: 'POST',
      body: JSON.stringify({ ids, libraryId: target.libraryId, targetPath: target.folder ?? '' }),
    });
    notify(ids.length === 1 ? 'File moved' : `${ids.length} files moved`);
    selectionAnchorId.current = null;
    setSelectedIds([]);
    await load();
  };

  const moveFolder = async (folder: DraggedFolder, target: { libraryId: string; folder?: string }) => {
    if (config?.readOnly || !folder.path) return;
    const result = await api<{ relativePath: string }>('/api/folders/move', {
      method: 'POST',
      body: JSON.stringify({
        libraryId: folder.libraryId,
        sourcePath: folder.path,
        targetLibraryId: target.libraryId,
        targetPath: target.folder ?? '',
      }),
    });
    if (folderFilter.libraryId === folder.libraryId && folderFilter.folder && isSameOrChildFolder(folderFilter.folder, folder.path)) {
      const suffix = folderFilter.folder === folder.path ? '' : folderFilter.folder.slice(folder.path.length + 1);
      setFolderFilter({ libraryId: target.libraryId, folder: suffix ? `${result.relativePath}/${suffix}` : result.relativePath });
    }
    notify('Folder moved');
    await load();
  };

  const deleteItems = async (idsToDelete = selectedIds) => {
    if (idsToDelete.length === 0 || config?.readOnly) return;
    const confirmed = window.confirm(`Move ${idsToDelete.length === 1 ? 'this file' : `${idsToDelete.length} files`} to trash?`);
    if (!confirmed) return;
    await api('/api/delete', {
      method: 'POST',
      body: JSON.stringify({ ids: idsToDelete }),
    });
    notify(idsToDelete.length === 1 ? 'File moved to trash' : `${idsToDelete.length} files moved to trash`);
    clearSelection();
    await load();
  };

  const copySelectedFiles = async (itemsToCopy = selectedItems) => {
    if (itemsToCopy.length === 0) {
      notify('No files selected');
      return;
    }
    try {
      const copyItems = itemsToCopy.filter((item) => item.kind === 'image');
      if (copyItems.length === 0) {
        notify('Copy image data supports images only');
        return;
      }
      if (!('ClipboardItem' in window) || !navigator.clipboard?.write) {
        notify('This browser does not allow image clipboard writes');
        return;
      }
      const clipboardItems = await Promise.all(
        copyItems.map(async (item) => new ClipboardItem({ 'image/png': await mediaItemToPngBlob(item) })),
      );
      const copiedMultiple = await tryWriteClipboardItems(clipboardItems);
      if (copiedMultiple) {
        notify(copyItems.length === 1 ? 'Image copied' : `${copyItems.length} images copied`);
        return;
      }

      if (copyItems.length > 1) {
        const copiedHtml = await tryWriteEmbeddedImageHtml(copyItems);
        if (copiedHtml) {
          notify(`${copyItems.length} embedded images copied`);
          return;
        }
      }

      await navigator.clipboard.write([clipboardItems[0]]);
      notify(copyItems.length === 1 ? 'Image copied' : 'Browser only allowed the first image');
    } catch (error) {
      console.error(error);
      notify('Browser blocked image clipboard copy');
    }
  };

  const copyShareLink = async (item?: MediaItem) => {
    const url = new URL(window.location.href);
    url.search = '';
    if (item) {
      url.searchParams.set('utm_source', 'onefolder-web');
      url.searchParams.set('utm_medium', 'share');
      url.searchParams.set('utm_campaign', 'media-link');
      url.searchParams.set('media', item.id);
    } else {
      if (query.trim()) url.searchParams.set('q', query.trim());
      if (tagFilter.trim()) url.searchParams.set('tags', tagFilter.trim());
      if (folderFilter.folder) url.searchParams.set('folder', folderFilter.folder);
      url.searchParams.set('utm_source', 'onefolder-web');
      url.searchParams.set('utm_medium', 'share');
      url.searchParams.set('utm_campaign', 'filter-link');
    }
    await writeTextToClipboard(url.toString());
    notify('Share link copied');
  };

  const downloadMedia = (item: MediaItem) => {
    triggerDownload(`/download/${encodeURIComponent(item.id)}`);
  };

  const downloadSelectedFiles = (itemsToDownload = selectedItems) => {
    if (itemsToDownload.length === 0) {
      notify('No files selected');
      return;
    }
    const ids = itemsToDownload.map((item) => item.id).join(',');
    triggerDownload(`/api/download?ids=${encodeURIComponent(ids)}`);
    notify(itemsToDownload.length === 1 ? 'Download started' : `${itemsToDownload.length} files downloading`);
  };

  const saveTagCatalog = async (tags: string[]) => {
    const catalog = await api<string[]>('/api/tags/catalog', {
      method: 'PUT',
      body: JSON.stringify({ tags }),
    });
    setSettings((current) => (current ? { ...current, tagCatalog: catalog } : current));
    notify('Tag catalog saved');
    await load();
  };

  const saveTagAliases = async (tag: string, aliases: string[]) => {
    const tagAliases = await api<Record<string, string[]>>('/api/tags/aliases', {
      method: 'PUT',
      body: JSON.stringify({ tag, aliases }),
    });
    setSettings((current) => (current ? { ...current, tagAliases } : current));
    notify('Tag aliases saved');
    await load();
  };

  const leaveTagManager = () => {
    setTagManagerOpen(false);
  };

  const renameTag = async (from: string, to: string) => {
    await api('/api/tags/rename', {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    });
    notify('Tag renamed');
    await load();
  };

  const moveTag = async (tag: string, newParent: string) => {
    const cleanTag = normalizeTag(tag);
    const cleanParent = normalizeTag(newParent);
    const name = cleanTag.split('/').at(-1);
    if (!cleanTag || !name) return;
    const target = cleanParent ? normalizeTag(`${cleanParent}/${name}`) : name;
    if (target === cleanTag || cleanParent.startsWith(`${cleanTag}/`)) return;
    await renameTag(cleanTag, target);
  };

  const deleteTag = async (tag: string) => {
    const confirmed = window.confirm(`Remove "${tag}" from the catalog and matching files?`);
    if (!confirmed) return;
    await api(`/api/tags?tag=${encodeURIComponent(tag)}`, { method: 'DELETE' });
    notify('Tag removed');
    await load();
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const media = params.get('media');
    if (media) setActiveId(media);
    setQuery(params.get('q') ?? '');
    setTagFilter(params.get('tags') ?? '');
    const folder = params.get('folder');
    if (folder) setFolderFilter((current) => ({ ...current, folder }));
  }, []);

  return (
    <main
      className={`shell ${isDragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => {
        if (hasExternalFiles(event.dataTransfer)) {
          event.preventDefault();
          if (!config?.readOnly) setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!hasExternalFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(false);
        if (!config?.readOnly) void uploadFiles(event.dataTransfer.files);
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          {config?.siteImageUrl ? <img src={config.siteImageUrl} alt="" /> : <Sparkles size={22} />}
          <div>
            <strong>{config?.siteName ?? 'OneFolder Web'}</strong>
            <span>v{config?.version ?? '...'}</span>
          </div>
        </div>
        {config?.readOnly && (
          <div className="readonly">
            <Shield size={16} />
            Read-only instance
          </div>
        )}
        <div className="sidebar-tabs" role="tablist" aria-label="Sidebar sections">
          <button className={sidebarTab === 'libraries' ? 'active' : ''} onClick={() => setSidebarTab('libraries')}>Libraries</button>
          <button className={sidebarTab === 'tags' ? 'active' : ''} onClick={() => setSidebarTab('tags')}>Tags</button>
        </div>
        {sidebarTab === 'libraries' ? (
          <>
            <FolderTree
              nodes={tree}
              selected={folderFilter}
              readOnly={Boolean(config?.readOnly)}
              onSelect={(next) => {
                leaveTagManager();
                setFolderFilter(next);
              }}
              onMove={moveItems}
              onMoveFolder={moveFolder}
            />
            <div className="sidebar-actions">
              <div className="inline-input">
                <input
                  value={folderDraft}
                  onFocus={leaveTagManager}
                  onChange={(event) => setFolderDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      leaveTagManager();
                      void createFolder();
                    }
                  }}
                  placeholder="New folder"
                  disabled={config?.readOnly}
                />
                <button title="Create folder" onClick={() => {
                  leaveTagManager();
                  void createFolder();
                }} disabled={config?.readOnly || !folderDraft.trim()}>
                  <FolderPlus size={17} />
                </button>
              </div>
              <label className={`upload-button ${config?.readOnly ? 'disabled' : ''}`}>
                <Upload size={17} />
                Upload
                <input type="file" multiple disabled={config?.readOnly} onChange={(event) => {
                  leaveTagManager();
                  if (event.target.files) void uploadFiles(event.target.files);
                }} />
              </label>
            </div>
          </>
        ) : (
          <TagSidebar
            summaries={tagSummaries}
            activeTag={tagFilter}
            sort={tagSort}
            onSort={setTagSort}
            onSelect={(tag) => {
              leaveTagManager();
              setTagFilter(tag);
            }}
          />
        )}
      </aside>

      <section className="workspace">
        <header className="toolbar">
          <div className="search-box">
            <Search size={18} />
            <input value={query} onFocus={leaveTagManager} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tags, folders, filenames, descriptions" />
          </div>
          <div className="tag-filter">
            <Tags size={18} />
            <input value={tagFilter} onFocus={leaveTagManager} onChange={(event) => setTagFilter(event.target.value)} placeholder="Tags: (dog OR cat) AND food" list="known-tags" />
            <datalist id="known-tags">{allTags.map((tag) => <option key={tag} value={tag} label={displayTag(tag)} />)}</datalist>
          </div>
          <div className="toolbar-actions">
            <div className="view-switcher">
              {viewOptions.map((option) => {
                const Icon = option.icon;
                return (
                  <button key={option.id} title={option.label} className={view === option.id ? 'active' : ''} onClick={() => {
                    leaveTagManager();
                    setView(option.id);
                  }}>
                    <Icon size={18} />
                  </button>
                );
              })}
            </div>
            <div className="browse-order" role="group" aria-label="Browse order">
              <button title="Linear order" className={browseOrder === 'linear' ? 'active' : ''} onClick={() => setBrowseOrder('linear')}>
                <LayoutList size={18} />
              </button>
              <button title="Shuffle current view" className={browseOrder === 'shuffle' ? 'active' : ''} onClick={shuffleCurrentItems}>
                <Shuffle size={18} />
              </button>
            </div>
            <label className="slideshow-delay" title="Seconds per slide">
              <input
                type="number"
                min={1}
                max={600}
                value={slideshowSeconds}
                onChange={(event) => setSlideshowSeconds(clampNumber(Number(event.target.value), 1, 600))}
              />
            </label>
            <button title="Start fullscreen slideshow" onClick={startSlideshow}>
              <Play size={18} />
            </button>
            <button title="Tag manager" className={tagManagerOpen ? 'active' : ''} onClick={() => setTagManagerOpen((open) => !open)}>
              <Tags size={18} />
            </button>
            <button title="Copy filter link" onClick={() => {
              leaveTagManager();
              void copyShareLink();
            }}>
              <Link size={18} />
            </button>
            <button title="Settings" className={settingsOpen ? 'active' : ''} onClick={() => {
              leaveTagManager();
              setSettingsOpen((open) => !open);
            }}>
              <Settings size={18} />
            </button>
          </div>
        </header>

        <IndexStatusBar status={indexStatus} isLoading={isLoadingLibrary} isPrefetching={isPrefetchingMedia} visibleCount={items.length} totalCount={mediaTotal} />

        {settingsOpen && settings && config && (
          <SettingsPanel settings={settings} config={config} onSaved={async (next) => {
            await api('/api/settings', { method: 'PUT', body: JSON.stringify(next) });
            notify('Settings saved');
            setSettings(next);
            await load();
          }} />
        )}

        {tagManagerOpen && settings && config ? (
          <TagManager
            tags={managedTags}
            aliases={settings.tagAliases}
            selectedCount={selectedIds.length}
            readOnly={config.readOnly}
            onFilter={(tag) => setTagFilter(tag)}
            onApply={(tag) => applyTagToSelection(tag, 'add')}
            onRemoveFromSelection={(tag) => applyTagToSelection(tag, 'remove')}
            onCatalogSave={saveTagCatalog}
            onAliasesSave={saveTagAliases}
            onRename={renameTag}
            onMove={moveTag}
            onDelete={deleteTag}
          />
        ) : (
          <>
            <BulkBar
              selectedItems={selectedItems}
              tagDraft={tagDraft}
              descriptionDraft={descriptionDraft}
              readOnly={Boolean(config?.readOnly)}
              onTagDraft={setTagDraft}
              onDescriptionDraft={setDescriptionDraft}
              onApplyTags={applyTags}
              onCopy={copySelectedFiles}
              onCopyLink={() => selectedItems[0] && copyShareLink(selectedItems[0])}
              onDownload={() => downloadSelectedFiles(selectedItems)}
              onDelete={() => deleteItems(selectedIds)}
            />

            <Gallery
              view={view}
              items={orderedItems}
              selectedIds={selectedIds}
              hasMore={items.length < mediaTotal}
              isPrefetching={isPrefetchingMedia || isLoadingLibrary}
              onSelect={selectItem}
              onOpen={openItem}
              onClear={clearSelection}
              onPrefetch={prefetchMoreMedia}
              onDownload={downloadMedia}
              onDragStart={(item, event) => {
                const ids = selectedIds.includes(item.id) ? selectedIds : [item.id];
                selectionAnchorId.current = item.id;
                setSelectedIds(ids);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('application/x-onefolder-media', JSON.stringify(ids));
                event.dataTransfer.setData('text/plain', ids.join(','));
              }}
            />
          </>
        )}
      </section>

      {activeItem && (
        <DetailView
          item={activeItem}
          readOnly={Boolean(config?.readOnly)}
          descriptionDraft={descriptionDraft}
          onDescriptionDraft={setDescriptionDraft}
          tagDraft={tagDraft}
          onTagDraft={setTagDraft}
          onClose={() => setActiveId(null)}
          onSave={() => applyTags(tagDraft.trim() ? 'add' : 'replace')}
          onRemoveTag={(tag) => removeTagFromItem(activeItem.id, tag)}
          onCopy={() => copySelectedFiles(selectedItems.length > 0 ? selectedItems : [activeItem])}
          onCopyLink={() => copyShareLink(activeItem)}
          onDownload={() => downloadMedia(activeItem)}
          onDelete={() => deleteItems(selectedIds.length > 0 ? selectedIds : [activeItem.id])}
        />
      )}

      {slideshowOpen && (
        <SlideshowView
          items={slideshowItems}
          seconds={slideshowSeconds}
          hasMore={items.length < mediaTotal}
          isPrefetching={isPrefetchingMedia || isLoadingLibrary}
          onPrefetch={prefetchMoreMedia}
          onClose={closeSlideshow}
        />
      )}

      <div className="toasts">{toasts.map((toast) => <div key={toast.id}>{toast.message}</div>)}</div>
      {isDragging && <div className="drop-hint">Drop files into the selected folder</div>}
    </main>
  );
}

function FolderTree({
  nodes,
  selected,
  readOnly,
  onSelect,
  onMove,
  onMoveFolder,
}: {
  nodes: FolderNode[];
  selected: { libraryId?: string; folder?: string };
  readOnly: boolean;
  onSelect: (next: { libraryId?: string; folder?: string }) => void;
  onMove: (ids: string[], target: { libraryId: string; folder?: string }) => Promise<void>;
  onMoveFolder: (folder: DraggedFolder, target: { libraryId: string; folder?: string }) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const appliedDefaultsRef = useRef(new Map<string, boolean>());
  useEffect(() => {
    setCollapsed((current) => {
      const next = new Set(current);
      const visibleIds = new Set(nodes.map((node) => node.id));
      for (const key of appliedDefaultsRef.current.keys()) {
        if (!visibleIds.has(key)) appliedDefaultsRef.current.delete(key);
      }
      for (const node of nodes) {
        const startExpanded = node.startExpanded !== false;
        if (appliedDefaultsRef.current.get(node.id) === startExpanded) continue;
        appliedDefaultsRef.current.set(node.id, startExpanded);
        if (startExpanded) next.delete(node.id);
        else next.add(node.id);
      }
      return next;
    });
  }, [nodes]);
  const toggleCollapsed = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <nav className="folder-tree">
      <button className={!selected.libraryId && !selected.folder ? 'selected' : ''} onClick={() => onSelect({})}>All libraries</button>
      {nodes.map((node) => (
        <FolderNodeView
          key={node.id}
          node={node}
          collapsed={collapsed}
          selected={selected}
          readOnly={readOnly}
          onSelect={onSelect}
          onMove={onMove}
          onMoveFolder={onMoveFolder}
          onToggle={toggleCollapsed}
        />
      ))}
    </nav>
  );
}

function TagSidebar({
  summaries,
  activeTag,
  sort,
  onSort,
  onSelect,
}: {
  summaries: TagSummary[];
  activeTag: string;
  sort: TagSortMode;
  onSort: (sort: TagSortMode) => void;
  onSelect: (tag: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const sortedTree = useMemo(() => {
    const compare = (a: TagSummaryTreeNode, b: TagSummaryTreeNode) => {
      if (sort === 'count') return b.count - a.count || a.tag.localeCompare(b.tag);
      return a.tag.localeCompare(b.tag);
    };
    const sortNodes = (nodes: TagSummaryTreeNode[]) => {
      nodes.sort(compare);
      nodes.forEach((node) => sortNodes(node.children));
      return nodes;
    };
    return sortNodes(buildTagSummaryTree(summaries));
  }, [sort, summaries]);
  const toggleCollapsed = (tag: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  return (
    <section className="tag-sidebar">
      <div className="tag-sort">
        <button className={sort === 'alpha' ? 'active' : ''} onClick={() => onSort('alpha')}>A-Z</button>
        <button className={sort === 'count' ? 'active' : ''} onClick={() => onSort('count')}>Count</button>
      </div>
      <nav className="sidebar-tag-list" aria-label="Available tags">
        {sortedTree.length === 0 ? (
          <span>No tags yet</span>
        ) : (
          sortedTree.map((node) => (
            <TagSummaryNodeView
              key={node.tag}
              node={node}
              activeTag={activeTag}
              collapsed={collapsed}
              onSelect={onSelect}
              onToggle={toggleCollapsed}
            />
          ))
        )}
      </nav>
    </section>
  );
}

type TagSummaryTreeNode = TagSummary & {
  name: string;
  children: TagSummaryTreeNode[];
};

function TagSummaryNodeView({
  node,
  activeTag,
  collapsed,
  onSelect,
  onToggle,
}: {
  node: TagSummaryTreeNode;
  activeTag: string;
  collapsed: Set<string>;
  onSelect: (tag: string) => void;
  onToggle: (tag: string) => void;
}) {
  const isCollapsed = collapsed.has(node.tag);
  const hasChildren = node.children.length > 0;
  return (
    <div className="sidebar-tag-node">
      <div className="tree-row" style={{ paddingLeft: node.tag.split('/').length * 10 - 10 }}>
        {hasChildren ? (
          <button className="tree-toggle" title={isCollapsed ? 'Expand tag' : 'Collapse tag'} onClick={() => onToggle(node.tag)}>
            {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        <button
          className={`tree-item ${normalizeTag(activeTag).toLowerCase() === node.tag.toLowerCase() ? 'selected' : ''}`}
          title={node.tag}
          onClick={() => onSelect(node.tag)}
        >
          <span>{displayTag(node.name)}</span>
          <small>({node.count.toLocaleString()})</small>
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <div className="sidebar-tag-children">
          {node.children.map((child) => (
            <TagSummaryNodeView key={child.tag} node={child} activeTag={activeTag} collapsed={collapsed} onSelect={onSelect} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderNodeView({
  node,
  collapsed,
  selected,
  readOnly,
  onSelect,
  onMove,
  onMoveFolder,
  onToggle,
}: {
  node: FolderNode;
  collapsed: Set<string>;
  selected: { libraryId?: string; folder?: string };
  readOnly: boolean;
  onSelect: (next: { libraryId?: string; folder?: string }) => void;
  onMove: (ids: string[], target: { libraryId: string; folder?: string }) => Promise<void>;
  onMoveFolder: (folder: DraggedFolder, target: { libraryId: string; folder?: string }) => Promise<void>;
  onToggle: (id: string) => void;
}) {
  const isSelected = selected.libraryId === node.libraryId && (selected.folder ?? '') === node.relativePath;
  const [isDropTarget, setDropTarget] = useState(false);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  return (
    <div>
      <div className="tree-row" style={{ paddingLeft: node.depth * 14 }}>
        {hasChildren ? (
          <button className="tree-toggle" title={isCollapsed ? 'Expand folder' : 'Collapse folder'} onClick={() => onToggle(node.id)}>
            {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        <button
          className={`tree-item ${isSelected ? 'selected' : ''} ${isDropTarget ? 'drop-target' : ''}`}
          draggable={!readOnly && Boolean(node.relativePath)}
          onDragStart={(event) => {
            if (!node.relativePath) return;
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-onefolder-folder', JSON.stringify({ libraryId: node.libraryId, path: node.relativePath } satisfies DraggedFolder));
            event.dataTransfer.setData('text/plain', node.relativePath);
          }}
          onClick={() => onSelect({ libraryId: node.libraryId, folder: node.relativePath })}
          onDragOver={(event) => {
            if (readOnly || !canDropOnFolder(event.dataTransfer, node)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(true);
          }}
          onDragLeave={() => setDropTarget(false)}
          onDrop={(event) => {
            if (readOnly) return;
            const rawFolder = event.dataTransfer.getData('application/x-onefolder-folder');
            const rawIds = event.dataTransfer.getData('application/x-onefolder-media');
            if (!rawIds && !rawFolder) return;
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(false);
            if (rawFolder) {
              const folder = parseDraggedFolder(rawFolder);
              if (!folder) return;
              if (canMoveFolderTo(folder, node)) void onMoveFolder(folder, { libraryId: node.libraryId, folder: node.relativePath });
              return;
            }
            if (rawIds) {
              const ids = JSON.parse(rawIds) as string[];
              void onMove(ids, { libraryId: node.libraryId, folder: node.relativePath });
            }
          }}
        >
          <span>{node.name}</span>
          <small>{node.itemCount}</small>
        </button>
      </div>
      {hasChildren && !isCollapsed && node.children.map((child) => (
        <FolderNodeView
          key={child.id}
          node={child}
          collapsed={collapsed}
          selected={selected}
          readOnly={readOnly}
          onSelect={onSelect}
          onMove={onMove}
          onMoveFolder={onMoveFolder}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

function IndexStatusBar({
  status,
  isLoading,
  isPrefetching,
  visibleCount,
  totalCount,
}: {
  status: IndexStatus | null;
  isLoading: boolean;
  isPrefetching: boolean;
  visibleCount: number;
  totalCount: number;
}) {
  const isBusy = Boolean(isLoading || isPrefetching || status?.isScanning);
  const detail = status?.isScanning
    ? `${status.phase} - ${status.filesSeen} seen, ${status.filesIndexed} updated`
    : `${visibleCount.toLocaleString()} of ${totalCount.toLocaleString()} loaded`;
  const title = status?.isScanning ? 'Indexing library' : isPrefetching ? 'Loading more media' : isLoading ? 'Loading library' : 'Library ready';

  return (
    <div className={`index-status ${isBusy ? 'busy' : ''}`}>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {status?.currentPath && <small>{status.currentPath}</small>}
      <div className="index-progress" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}

function BulkBar(props: {
  selectedItems: MediaItem[];
  tagDraft: string;
  descriptionDraft: string;
  readOnly: boolean;
  onTagDraft: (value: string) => void;
  onDescriptionDraft: (value: string) => void;
  onApplyTags: (mode: 'replace' | 'add' | 'remove') => Promise<void>;
  onCopy: () => Promise<void>;
  onCopyLink: () => void;
  onDownload: () => void;
  onDelete: () => Promise<void>;
}) {
  if (props.selectedItems.length === 0) return null;
  return (
    <div className="bulkbar">
      <strong>{props.selectedItems.length} selected</strong>
      <input
        value={props.tagDraft}
        onChange={(event) => props.onTagDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (!props.readOnly) void props.onApplyTags('add');
          }
        }}
        placeholder="Comma-separated tags"
        disabled={props.readOnly}
      />
      <input value={props.descriptionDraft} onChange={(event) => props.onDescriptionDraft(event.target.value)} placeholder="Description for selected files" disabled={props.readOnly} />
      <button onClick={() => props.onApplyTags('add')} disabled={props.readOnly}><Tags size={16} />Add</button>
      <button onClick={() => props.onApplyTags('replace')} disabled={props.readOnly}><Check size={16} />Replace</button>
      <button onClick={() => props.onApplyTags('remove')} disabled={props.readOnly}>Remove</button>
      <button onClick={() => void props.onCopy()}><Clipboard size={16} />Copy</button>
      <button onClick={props.onCopyLink}><Link size={16} />Link</button>
      <button onClick={props.onDownload}><Download size={16} />Download</button>
      <button onClick={() => void props.onDelete()} disabled={props.readOnly}><Trash2 size={16} />Trash</button>
    </div>
  );
}

type TagTreeNode = {
  path: string;
  name: string;
  children: TagTreeNode[];
};

function TagManager(props: {
  tags: string[];
  aliases: Record<string, string[]>;
  selectedCount: number;
  readOnly: boolean;
  onFilter: (tag: string) => void;
  onApply: (tag: string) => Promise<void>;
  onRemoveFromSelection: (tag: string) => Promise<void>;
  onCatalogSave: (tags: string[]) => Promise<void>;
  onAliasesSave: (tag: string, aliases: string[]) => Promise<void>;
  onRename: (from: string, to: string) => Promise<void>;
  onMove: (tag: string, newParent: string) => Promise<void>;
  onDelete: (tag: string) => Promise<void>;
}) {
  const [selectedTag, setSelectedTag] = useState('');
  const [newTagName, setNewTagName] = useState('');
  const [renameDraft, setRenameDraft] = useState('');
  const [aliasDraft, setAliasDraft] = useState('');
  const [collapsedTags, setCollapsedTags] = useState<Set<string>>(() => new Set());
  const [rootDropTarget, setRootDropTarget] = useState(false);
  const tree = useMemo(() => buildTagTree(props.tags), [props.tags]);

  useEffect(() => {
    setAliasDraft(selectedTag ? (props.aliases[selectedTag] ?? []).join(', ') : '');
  }, [props.aliases, selectedTag]);

  const toggleCollapsedTag = (tag: string) => {
    setCollapsedTags((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const createTag = async () => {
    const clean = normalizeTag(newTagName);
    if (!clean) return;
    const tag = selectedTag ? normalizeTag(`${selectedTag}/${clean}`) : clean;
    await props.onCatalogSave([...props.tags, tag]);
    setSelectedTag(tag);
    setNewTagName('');
  };

  const renameSelected = async () => {
    const clean = normalizeTag(renameDraft);
    if (!selectedTag || !clean) return;
    const parent = selectedTag.includes('/') ? selectedTag.slice(0, selectedTag.lastIndexOf('/')) : '';
    const target = clean.includes('/') ? clean : normalizeTag(parent ? `${parent}/${clean}` : clean);
    await props.onRename(selectedTag, target);
    setSelectedTag(target);
    setRenameDraft('');
  };

  const saveAliases = async () => {
    if (!selectedTag) return;
    const aliases = aliasDraft.split(',').map(normalizeTag).filter((alias) => alias && alias !== selectedTag);
    await props.onAliasesSave(selectedTag, Array.from(new Set(aliases)));
  };

  return (
    <section className="tag-manager">
      <div className="tag-manager-tree">
        <strong>Tags</strong>
        <button
          className={`tree-item ${!selectedTag ? 'selected' : ''} ${rootDropTarget ? 'drop-target' : ''}`}
          onClick={() => setSelectedTag('')}
          onDragOver={(event) => {
            if (props.readOnly || !event.dataTransfer.types.includes('application/x-onefolder-tag')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setRootDropTarget(true);
          }}
          onDragLeave={() => setRootDropTarget(false)}
          onDrop={(event) => {
            if (props.readOnly) return;
            const tag = event.dataTransfer.getData('application/x-onefolder-tag');
            if (!tag) return;
            event.preventDefault();
            setRootDropTarget(false);
            void props.onMove(tag, '');
          }}
        >
          Root
        </button>
        {tree.map((node) => (
          <TagNodeView
            key={node.path}
            node={node}
            selectedTag={selectedTag}
            collapsed={collapsedTags}
            readOnly={props.readOnly}
            onSelect={(tag) => {
              setSelectedTag(tag);
              setRenameDraft(tag.split('/').at(-1) ?? tag);
            }}
            onMove={props.onMove}
            onToggle={toggleCollapsedTag}
          />
        ))}
      </div>
      <div className="tag-manager-actions">
        <div>
          <strong title={selectedTag || undefined}>{selectedTag ? displayTag(selectedTag) : 'Root'}</strong>
          <span>{props.selectedCount} selected</span>
        </div>
        <div className="inline-input">
          <input
            value={newTagName}
            onChange={(event) => setNewTagName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void createTag();
              }
            }}
            placeholder={selectedTag ? 'New child tag' : 'New root tag'}
            disabled={props.readOnly}
          />
          <button title="Create tag" onClick={createTag} disabled={props.readOnly || !newTagName.trim()}><Plus size={17} /></button>
        </div>
        <div className="inline-input">
          <input
            value={renameDraft}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void renameSelected();
              }
            }}
            placeholder="Rename selected tag"
            disabled={props.readOnly || !selectedTag}
          />
          <button title="Rename tag" onClick={renameSelected} disabled={props.readOnly || !selectedTag || !renameDraft.trim()}><Pencil size={17} /></button>
        </div>
        <label className="tag-alias-editor">
          Aliases
          <div className="inline-input">
            <input
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveAliases();
                }
              }}
              placeholder="doggo, perro, inu"
              disabled={props.readOnly || !selectedTag}
            />
            <button title="Save aliases" onClick={saveAliases} disabled={props.readOnly || !selectedTag}><Check size={17} /></button>
          </div>
        </label>
        <div className="tag-manager-buttons">
          <button onClick={() => selectedTag && props.onFilter(selectedTag)} disabled={!selectedTag}>Filter</button>
          <button onClick={() => selectedTag && void props.onApply(selectedTag)} disabled={props.readOnly || !selectedTag || props.selectedCount === 0}>Apply</button>
          <button onClick={() => selectedTag && void props.onRemoveFromSelection(selectedTag)} disabled={props.readOnly || !selectedTag || props.selectedCount === 0}>Remove</button>
          <button onClick={() => selectedTag && void props.onDelete(selectedTag)} disabled={props.readOnly || !selectedTag}><Trash2 size={16} />Tag</button>
        </div>
      </div>
    </section>
  );
}

function TagNodeView({
  node,
  selectedTag,
  collapsed,
  readOnly,
  onSelect,
  onMove,
  onToggle,
}: {
  node: TagTreeNode;
  selectedTag: string;
  collapsed: Set<string>;
  readOnly: boolean;
  onSelect: (tag: string) => void;
  onMove: (tag: string, newParent: string) => Promise<void>;
  onToggle: (tag: string) => void;
}) {
  const [isDropTarget, setDropTarget] = useState(false);
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.path);
  return (
    <div className="tag-node">
      <div className="tree-row">
        {hasChildren ? (
          <button className="tree-toggle" title={isCollapsed ? 'Expand tag' : 'Collapse tag'} onClick={() => onToggle(node.path)}>
            {isCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
        ) : (
          <span className="tree-toggle-spacer" />
        )}
        <button
          className={`tree-item ${selectedTag === node.path ? 'selected' : ''} ${isDropTarget ? 'drop-target' : ''}`}
          draggable={!readOnly}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-onefolder-tag', node.path);
            event.dataTransfer.setData('text/plain', node.path);
          }}
          onDragOver={(event) => {
            if (readOnly || !event.dataTransfer.types.includes('application/x-onefolder-tag')) return;
            const dragged = event.dataTransfer.getData('application/x-onefolder-tag');
            if (dragged && (dragged === node.path || node.path.startsWith(`${dragged}/`))) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(true);
          }}
          onDragLeave={() => setDropTarget(false)}
          onDrop={(event) => {
            if (readOnly) return;
            const tag = event.dataTransfer.getData('application/x-onefolder-tag');
            if (!tag || tag === node.path || node.path.startsWith(`${tag}/`)) return;
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(false);
            void onMove(tag, node.path);
          }}
          onClick={() => onSelect(node.path)}
        >
          {node.name}
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <div className="tag-children">
          {node.children.map((child) => (
            <TagNodeView
              key={child.path}
              node={child}
              selectedTag={selectedTag}
              collapsed={collapsed}
              readOnly={readOnly}
              onSelect={onSelect}
              onMove={onMove}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Gallery({
  view,
  items,
  selectedIds,
  hasMore,
  isPrefetching,
  onSelect,
  onOpen,
  onClear,
  onPrefetch,
  onDownload,
  onDragStart,
}: {
  view: ViewMode;
  items: MediaItem[];
  selectedIds: string[];
  hasMore: boolean;
  isPrefetching: boolean;
  onSelect: (item: MediaItem, event?: React.MouseEvent) => void;
  onOpen: (item: MediaItem) => void;
  onClear: () => void;
  onPrefetch: () => Promise<void>;
  onDownload: (item: MediaItem) => void;
  onDragStart: (item: MediaItem, event: React.DragEvent) => void;
}) {
  const { scrollRef, maybePrefetch } = useAutoPrefetch(hasMore, isPrefetching, onPrefetch, items.length);
  if (items.length === 0) {
    return <div className="empty-state" onClick={onClear}>No media matches the current filters.</div>;
  }
  if (view === 'list') return <ListGallery items={items} selectedIds={selectedIds} hasMore={hasMore} isPrefetching={isPrefetching} onSelect={onSelect} onOpen={onOpen} onClear={onClear} onPrefetch={onPrefetch} onDownload={onDownload} onDragStart={onDragStart} />;
  if (view === 'calendar') return <CalendarGallery items={items} selectedIds={selectedIds} hasMore={hasMore} isPrefetching={isPrefetching} onSelect={onSelect} onOpen={onOpen} onClear={onClear} onPrefetch={onPrefetch} onDownload={onDownload} onDragStart={onDragStart} />;
  if (view === 'masonry-vertical') {
    return (
      <div ref={scrollRef} className="gallery masonry-scroll pure" onScroll={maybePrefetch} onClick={(event) => {
        if (event.target === event.currentTarget) onClear();
      }}>
        <div className="masonry-columns" onClick={(event) => {
          if (event.target === event.currentTarget) onClear();
        }}>
          {items.map((item) => (
            <MediaTile
              key={item.id}
              item={item}
              selected={selectedIds.includes(item.id)}
              showMeta={false}
              onSelect={onSelect}
              onOpen={onOpen}
              onDownload={onDownload}
              onDragStart={onDragStart}
            />
          ))}
        </div>
      </div>
    );
  }
  const isMasonry = view === 'masonry-horizontal';
  const className = isMasonry ? 'gallery masonry horizontal pure' : 'gallery grid';
  return (
    <div ref={scrollRef} className={className} onScroll={maybePrefetch} onClick={(event) => {
      if (event.target === event.currentTarget) onClear();
    }}>
      {items.map((item) => (
        <MediaTile
          key={item.id}
          item={item}
          selected={selectedIds.includes(item.id)}
          showMeta={!isMasonry}
          onSelect={onSelect}
          onOpen={onOpen}
          onDownload={onDownload}
          onDragStart={onDragStart}
        />
      ))}
    </div>
  );
}

function MediaTile({ item, selected, showMeta = true, onSelect, onOpen, onDownload, onDragStart }: { item: MediaItem; selected: boolean; showMeta?: boolean; onSelect: (item: MediaItem, event?: React.MouseEvent) => void; onOpen: (item: MediaItem) => void; onDownload: (item: MediaItem) => void; onDragStart: (item: MediaItem, event: React.DragEvent) => void }) {
  const tileStyle = { '--media-aspect': mediaAspectRatio(item) } as CSSProperties;
  return (
    <article className={`tile ${selected ? 'selected' : ''}`} style={tileStyle} tabIndex={0} draggable onDragStart={(event) => onDragStart(item, event)} onClick={(event) => onSelect(item, event)} onDoubleClick={() => onOpen(item)}>
      <MediaThumb item={item} />
      {item.kind !== 'image' && <span className="kind">{mediaKindLabel(item)}</span>}
      <button className="tile-download" title="Download" onClick={(event) => {
        event.stopPropagation();
        onDownload(item);
      }}>
        <Download size={16} />
      </button>
      {showMeta && (
        <footer>
          <strong>{item.name}</strong>
          <span title={item.tags.join(', ')}>{displayTags(item.tags.slice(0, 3)) || item.folder || item.libraryName}</span>
        </footer>
      )}
    </article>
  );
}

function ListGallery({ items, selectedIds, hasMore, isPrefetching, onSelect, onOpen, onClear, onPrefetch, onDownload, onDragStart }: { items: MediaItem[]; selectedIds: string[]; hasMore: boolean; isPrefetching: boolean; onSelect: (item: MediaItem, event?: React.MouseEvent) => void; onOpen: (item: MediaItem) => void; onClear: () => void; onPrefetch: () => Promise<void>; onDownload: (item: MediaItem) => void; onDragStart: (item: MediaItem, event: React.DragEvent) => void }) {
  const { scrollRef, maybePrefetch } = useAutoPrefetch(hasMore, isPrefetching, onPrefetch, items.length);
  return (
    <div ref={scrollRef} className="list-gallery" onScroll={maybePrefetch} onClick={(event) => {
      if (event.target === event.currentTarget) onClear();
    }}>
      {items.map((item) => (
        <article key={item.id} tabIndex={0} draggable className={`list-row ${selectedIds.includes(item.id) ? 'selected' : ''}`} onDragStart={(event) => onDragStart(item, event)} onClick={(event) => onSelect(item, event)} onDoubleClick={() => onOpen(item)}>
          <MediaThumb item={item} compact />
          <span>{item.name}</span>
          <small>{item.folder || item.libraryName}</small>
          <small title={item.tags.join(', ')}>{displayTags(item.tags)}</small>
          <time>{new Date(item.createdAt).toLocaleDateString()}</time>
          <button title="Download" onClick={(event) => {
            event.stopPropagation();
            onDownload(item);
          }}>
            <Download size={16} />
          </button>
        </article>
      ))}
    </div>
  );
}

function MediaThumb({ item, compact = false }: { item: MediaItem; compact?: boolean }) {
  if (item.kind === 'image' || item.kind === 'video') {
    return <img src={item.thumbnailUrl} alt={compact ? '' : item.name} loading="lazy" />;
  }
  const Icon = item.kind === 'text' ? FileText : FileIcon;
  return (
    <div className={`file-thumb ${compact ? 'compact' : ''}`} aria-label={item.name}>
      <Icon size={compact ? 20 : 42} />
      <strong>{item.extension.toUpperCase()}</strong>
    </div>
  );
}

function CalendarGallery({ items, selectedIds, hasMore, isPrefetching, onSelect, onOpen, onClear, onPrefetch, onDownload, onDragStart }: { items: MediaItem[]; selectedIds: string[]; hasMore: boolean; isPrefetching: boolean; onSelect: (item: MediaItem, event?: React.MouseEvent) => void; onOpen: (item: MediaItem) => void; onClear: () => void; onPrefetch: () => Promise<void>; onDownload: (item: MediaItem) => void; onDragStart: (item: MediaItem, event: React.DragEvent) => void }) {
  const { scrollRef, maybePrefetch } = useAutoPrefetch(hasMore, isPrefetching, onPrefetch, items.length);
  const groups = useMemo(() => {
    const map = new Map<string, MediaItem[]>();
    items.forEach((item) => {
      const key = new Date(item.createdAt).toLocaleString(undefined, { month: 'long', year: 'numeric' });
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return Array.from(map.entries());
  }, [items]);
  return (
    <div ref={scrollRef} className="calendar-gallery" onScroll={maybePrefetch} onClick={(event) => {
      if (event.target === event.currentTarget) onClear();
    }}>
      {groups.map(([month, group]) => (
        <section key={month}>
          <h2>{month}</h2>
          <div className="calendar-grid" onClick={(event) => {
            if (event.target === event.currentTarget) onClear();
          }}>
            {group.map((item) => <MediaTile key={item.id} item={item} selected={selectedIds.includes(item.id)} onSelect={onSelect} onOpen={onOpen} onDownload={onDownload} onDragStart={onDragStart} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function useAutoPrefetch(hasMore: boolean, isPrefetching: boolean, onPrefetch: () => Promise<void>, itemCount: number) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const maybePrefetch = useCallback(() => {
    if (!hasMore || isPrefetching) return;
    const element = scrollRef.current;
    if (!element || !isHalfwayThroughLoadedMedia(element)) return;
    void onPrefetch();
  }, [hasMore, isPrefetching, onPrefetch]);

  useEffect(() => {
    maybePrefetch();
  }, [itemCount, maybePrefetch]);

  return { scrollRef, maybePrefetch };
}

function isHalfwayThroughLoadedMedia(element: HTMLElement): boolean {
  const verticalScrollable = element.scrollHeight > element.clientHeight + 8;
  const horizontalScrollable = element.scrollWidth > element.clientWidth + 8;
  if (verticalScrollable) return element.scrollTop + element.clientHeight >= element.scrollHeight * 0.5;
  if (horizontalScrollable) return element.scrollLeft + element.clientWidth >= element.scrollWidth * 0.5;
  return true;
}

function DetailView(props: {
  item: MediaItem;
  readOnly: boolean;
  descriptionDraft: string;
  tagDraft: string;
  onDescriptionDraft: (value: string) => void;
  onTagDraft: (value: string) => void;
  onClose: () => void;
  onSave: () => Promise<void>;
  onRemoveTag: (tag: string) => Promise<void>;
  onCopy: () => Promise<void>;
  onCopyLink: () => void;
  onDownload: () => void;
  onDelete: () => Promise<void>;
}) {
  const [fullLoaded, setFullLoaded] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [fitMode, setFitMode] = useState<DetailFitMode>('contain');
  const [naturalSize, setNaturalSize] = useState<Size | null>(imageItemSize(props.item));
  const [previewSize, setPreviewSize] = useState<Size | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const detailImageStyle = naturalSize && previewSize ? detailImageBox(naturalSize, previewSize, fitMode) : undefined;
  const hasInlinePreview = props.item.kind === 'image' || props.item.kind === 'video';

  useEffect(() => {
    setFullLoaded(false);
    setFitMode('contain');
    setNaturalSize(imageItemSize(props.item));
  }, [props.item.id]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const updatePreviewSize = () => {
      const rect = preview.getBoundingClientRect();
      setPreviewSize({ width: rect.width, height: rect.height });
    };
    updatePreviewSize();
    const observer = new ResizeObserver(updatePreviewSize);
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="detail" onClick={props.onClose}>
      <div className="detail-surface" onClick={(event) => event.stopPropagation()}>
        <button className="close" onClick={props.onClose}>x</button>
        <div ref={previewRef} className={`preview fit-${fitMode} ${fullLoaded ? 'loaded' : 'loading'}`}>
          {hasInlinePreview && !fullLoaded && props.item.kind === 'image' && (
            <img className="preview-thumb" src={props.item.previewThumbnailUrl} alt="" aria-hidden="true" />
          )}
          {hasInlinePreview && !fullLoaded && (
            <div className="full-load-indicator">
              <span>Loading full size</span>
              <div><i /></div>
            </div>
          )}
          {props.item.kind === 'video' ? (
            <video src={props.item.fileUrl} controls autoPlay onLoadedData={() => setFullLoaded(true)} />
          ) : props.item.kind === 'image' ? (
            <img
              className="preview-full"
              src={props.item.fileUrl}
              alt={props.item.name}
              style={detailImageStyle}
              title={fitMode === 'contain' ? 'Show cropped fill' : 'Show entire image'}
              onClick={() => setFitMode((mode) => (mode === 'contain' ? 'cover' : 'contain'))}
              onLoad={(event) => {
                setNaturalSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight });
                setFullLoaded(true);
              }}
            />
          ) : (
            <FilePreview item={props.item} />
          )}
        </div>
        <aside>
          <h1>{props.item.name}</h1>
          <p>{props.item.relativePath}</p>
          <dl>
            <dt>Size</dt><dd>{formatBytes(props.item.size)}</dd>
            <dt>Dimensions</dt><dd>{props.item.width && props.item.height ? `${props.item.width} x ${props.item.height}` : 'Unknown'}</dd>
            <dt>Created</dt><dd>{new Date(props.item.createdAt).toLocaleString()}</dd>
            <dt>Artist</dt><dd>{props.item.artist || 'Not set'}</dd>
          </dl>
          <label>
            Tags
            <input
              value={props.tagDraft}
              onChange={(event) => props.onTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (!props.readOnly) void props.onSave();
                }
              }}
              placeholder={props.item.tags.join(', ') || 'Animals/Dogs/DogName'}
              disabled={props.readOnly}
            />
          </label>
          <label>Description<textarea value={props.descriptionDraft} onChange={(event) => props.onDescriptionDraft(event.target.value)} disabled={props.readOnly} /></label>
          <div className="tag-list">
            {props.item.tags.map((tag) => (
              <button key={tag} title={props.readOnly ? tag : `Remove ${tag}`} onClick={() => void props.onRemoveTag(tag)} disabled={props.readOnly}>
                <span>{displayTag(tag)}</span>
                {!props.readOnly && <strong aria-hidden="true">x</strong>}
              </button>
            ))}
          </div>
          <div className="detail-actions">
            <button onClick={() => void props.onSave()} disabled={props.readOnly}><Check size={16} />Save {isMarkdownItem(props.item) ? 'metadata' : 'XMP'}</button>
            <button onClick={() => void props.onCopy()}><Copy size={16} />Copy</button>
            <button onClick={props.onCopyLink}><Link size={16} />Link</button>
            <button onClick={props.onDownload}><Download size={16} />Download</button>
            {props.item.kind === 'image' && <button onClick={() => setExportOpen(true)}><SlidersHorizontal size={16} />Export</button>}
            <button onClick={() => void props.onDelete()} disabled={props.readOnly}><Trash2 size={16} />Trash</button>
          </div>
        </aside>
      </div>
      {exportOpen && props.item.kind === 'image' && <ExportPanel item={props.item} onClose={() => setExportOpen(false)} />}
    </section>
  );
}

function SlideshowView({
  items,
  seconds,
  hasMore,
  isPrefetching,
  onPrefetch,
  onClose,
}: {
  items: MediaItem[];
  seconds: number;
  hasMore: boolean;
  isPrefetching: boolean;
  onPrefetch: () => Promise<void>;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const fullscreenEnteredRef = useRef(false);
  const preloadCacheRef = useRef(new Map<string, HTMLImageElement | HTMLVideoElement>());
  const current = items[index] ?? items[0];
  const next = useCallback(() => setIndex((value) => (items.length === 0 ? 0 : (value + 1) % items.length)), [items.length]);
  const previous = () => setIndex((value) => (items.length === 0 ? 0 : (value - 1 + items.length) % items.length));

  useLayoutEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const request = element.requestFullscreen?.();
    if (request) {
      void request.then(() => {
        fullscreenEnteredRef.current = true;
      }).catch(() => undefined);
    }
    const onFullscreenChange = () => {
      if (fullscreenEnteredRef.current && document.fullscreenElement !== element) onClose();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (document.fullscreenElement === element) void document.exitFullscreen();
    };
  }, [onClose]);

  useEffect(() => {
    if (items.length === 0) {
      onClose();
      return;
    }
    setIndex((value) => Math.min(value, items.length - 1));
  }, [items.length, onClose]);

  useEffect(() => {
    if (!current) return;
    const timer = window.setTimeout(next, seconds * 1000);
    return () => window.clearTimeout(timer);
  }, [current?.id, next, seconds]);

  useEffect(() => {
    const nearbyItems = nearbySlideshowItems(items, index, 2);
    const keepIds = new Set(nearbyItems.map((item) => item.id));
    for (const item of nearbyItems) {
      if (preloadCacheRef.current.has(item.id)) continue;
      if (item.kind === 'image') {
        const image = new Image();
        image.decoding = 'async';
        image.src = item.fileUrl;
        preloadCacheRef.current.set(item.id, image);
      } else {
        const video = document.createElement('video');
        video.preload = 'auto';
        video.muted = true;
        video.src = item.fileUrl;
        video.load();
        preloadCacheRef.current.set(item.id, video);
      }
    }
    for (const [id, element] of preloadCacheRef.current) {
      if (keepIds.has(id)) continue;
      if (element instanceof HTMLVideoElement) {
        element.pause();
        element.removeAttribute('src');
        element.load();
      }
      preloadCacheRef.current.delete(id);
    }
  }, [index, items]);

  useEffect(() => {
    if (hasMore && !isPrefetching && items.length - index <= 3) void onPrefetch();
  }, [hasMore, index, isPrefetching, items.length, onPrefetch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        previous();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [next, onClose]);

  if (!current) return null;

  return (
    <section ref={rootRef} className="slideshow" aria-label="Slideshow">
      <button className="slideshow-close" onClick={onClose}>x</button>
      <div className="slideshow-stage">
        {current.kind === 'video' ? (
          <video key={current.id} className="slideshow-media" src={current.fileUrl} autoPlay muted controls onEnded={next} />
        ) : (
          <img key={current.id} className="slideshow-media" src={current.fileUrl} alt={current.name} />
        )}
      </div>
      <div className="slideshow-controls">
        <button onClick={previous}>Previous</button>
        <span>{index + 1} / {items.length}</span>
        <button onClick={next}>Next</button>
        <strong title={current.relativePath}>{current.name}</strong>
      </div>
    </section>
  );
}

function FilePreview({ item }: { item: MediaItem }) {
  const isMarkdown = isMarkdownItem(item);
  const [markdownSource, setMarkdownSource] = useState('');
  const [markdownError, setMarkdownError] = useState('');
  const [isLoadingMarkdown, setLoadingMarkdown] = useState(false);

  useEffect(() => {
    let active = true;
    setMarkdownSource('');
    setMarkdownError('');
    if (!isMarkdown) {
      setLoadingMarkdown(false);
      return;
    }
    setLoadingMarkdown(true);
    fetch(item.fileUrl)
      .then((response) => {
        if (!response.ok) throw new Error('Could not load markdown');
        return response.text();
      })
      .then((text) => {
        if (active) setMarkdownSource(stripMarkdownFrontmatter(text));
      })
      .catch(() => {
        if (active) setMarkdownError('Could not load markdown preview');
      })
      .finally(() => {
        if (active) setLoadingMarkdown(false);
      });
    return () => {
      active = false;
    };
  }, [isMarkdown, item.fileUrl]);

  if (isMarkdown) {
    return <MarkdownPreview source={markdownSource} isLoading={isLoadingMarkdown} error={markdownError} />;
  }

  const Icon = item.kind === 'text' ? FileText : FileIcon;
  return (
    <div className="preview-file">
      <Icon size={56} />
      <strong>{item.extension.toUpperCase()}</strong>
      <span>{item.kind === 'text' ? 'Text document' : 'File'}</span>
    </div>
  );
}

function MarkdownPreview({ source, isLoading, error }: { source: string; isLoading: boolean; error: string }) {
  const html = useMemo(() => renderMarkdownHtml(source), [source]);
  if (isLoading) return <div className="markdown-preview"><p>Loading markdown...</p></div>;
  if (error) return <div className="markdown-preview"><p>{error}</p></div>;
  if (!html) return <div className="markdown-preview"><p>No markdown content</p></div>;
  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ExportPanel({ item, onClose }: { item: MediaItem; onClose: () => void }) {
  const naturalWidth = item.width ?? 1600;
  const naturalHeight = item.height ?? 1200;
  const [aspect, setAspect] = useState<ExportAspect>('original');
  const [width, setWidth] = useState(naturalWidth);
  const [height, setHeight] = useState(naturalHeight);
  const [crop, setCrop] = useState<CropRect>(() => defaultCropForAspect('original', naturalWidth, naturalHeight));
  const previewRef = useRef<HTMLDivElement | null>(null);

  const ratio = exportAspectRatio(aspect, naturalWidth, naturalHeight);
  const setExportWidth = (value: number) => {
    const nextWidth = Math.max(1, Math.round(value || 1));
    setWidth(nextWidth);
    setHeight(Math.max(1, Math.round(nextWidth / ratio)));
  };
  const setExportHeight = (value: number) => {
    const nextHeight = Math.max(1, Math.round(value || 1));
    setHeight(nextHeight);
    setWidth(Math.max(1, Math.round(nextHeight * ratio)));
  };
  const chooseAspect = (nextAspect: ExportAspect) => {
    const nextRatio = exportAspectRatio(nextAspect, naturalWidth, naturalHeight);
    setAspect(nextAspect);
    setCrop(defaultCropForAspect(nextAspect, naturalWidth, naturalHeight));
    setHeight(Math.max(1, Math.round(width / nextRatio)));
  };
  const moveCrop = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (aspect === 'original') return;
    const preview = previewRef.current;
    if (!preview) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, crop };
    const onPointerMove = (moveEvent: PointerEvent) => {
      const rect = preview.getBoundingClientRect();
      const dx = (moveEvent.clientX - start.x) / rect.width;
      const dy = (moveEvent.clientY - start.y) / rect.height;
      setCrop(constrainCrop({ ...start.crop, x: start.crop.x + dx, y: start.crop.y + dy }));
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };
  const resizeCrop = (handle: CropHandle, event: React.PointerEvent<HTMLSpanElement>) => {
    if (aspect === 'original') return;
    const preview = previewRef.current;
    if (!preview) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const ratio = exportAspectRatio(aspect, naturalWidth, naturalHeight);
    const imageRatio = naturalWidth / naturalHeight;
    const cropRatio = ratio / imageRatio;
    const anchorX = handle.includes('w') ? crop.x + crop.width : crop.x;
    const anchorY = handle.includes('n') ? crop.y + crop.height : crop.y;
    const onPointerMove = (moveEvent: PointerEvent) => {
      const rect = preview.getBoundingClientRect();
      const pointerX = (moveEvent.clientX - rect.left) / rect.width;
      const pointerY = (moveEvent.clientY - rect.top) / rect.height;
      setCrop(resizeCropFromAnchor(anchorX, anchorY, pointerX, pointerY, handle, cropRatio));
    };
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  return (
    <div className="export-panel" onClick={(event) => event.stopPropagation()}>
      <div>
        <strong>Export image</strong>
        <button className="close-export" onClick={onClose}>x</button>
      </div>
      <div className="export-options">
        {(['original', '16:9', '16:10', '1:1'] as ExportAspect[]).map((option) => (
          <button key={option} className={aspect === option ? 'active' : ''} onClick={() => chooseAspect(option)}>
            {option === 'original' ? 'Original ratio' : option}
          </button>
        ))}
      </div>
      <div className="export-crop-preview" ref={previewRef}>
        <img src={item.fileUrl} alt="" draggable={false} />
        <div className="crop-shade top" style={{ height: `${crop.y * 100}%` }} />
        <div className="crop-shade bottom" style={{ top: `${(crop.y + crop.height) * 100}%` }} />
        <div className="crop-shade left" style={{ top: `${crop.y * 100}%`, width: `${crop.x * 100}%`, height: `${crop.height * 100}%` }} />
        <div className="crop-shade right" style={{ top: `${crop.y * 100}%`, left: `${(crop.x + crop.width) * 100}%`, height: `${crop.height * 100}%` }} />
        <button
          className={`crop-box ${aspect === 'original' ? 'locked' : ''}`}
          style={{
            left: `${crop.x * 100}%`,
            top: `${crop.y * 100}%`,
            width: `${crop.width * 100}%`,
            height: `${crop.height * 100}%`,
          }}
          onPointerDown={moveCrop}
          type="button"
          title={aspect === 'original' ? 'Full image selected' : 'Drag crop selection'}
        >
          {(['nw', 'ne', 'sw', 'se'] as CropHandle[]).map((handle) => (
            <span
              key={handle}
              className={`crop-handle ${handle}`}
              onPointerDown={(event) => resizeCrop(handle, event)}
              aria-hidden="true"
            />
          ))}
        </button>
      </div>
      <div className="export-dimensions">
        <label>Width<input type="number" min={1} value={width} onChange={(event) => setExportWidth(Number(event.target.value))} /></label>
        <label>Height<input type="number" min={1} value={height} onChange={(event) => setExportHeight(Number(event.target.value))} /></label>
      </div>
      <button className="export-download" onClick={() => void exportScaledImage(item, width, height, crop)}>Download export</button>
    </div>
  );
}

function SettingsPanel({ settings, config, onSaved }: { settings: AppSettings; config: RuntimeConfig; onSaved: (settings: AppSettings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings);
  return (
    <section className="settings-panel">
      <div>
        <strong>Libraries</strong>
        <span>Blacklist: {config.blacklistedTags.join(', ') || 'none'}</span>
      </div>
      {draft.libraries.map((library, index) => (
        <div className="library-row" key={library.id}>
          <div className="library-order-controls">
            <button title="Move library up" onClick={() => setDraft(moveLibrary(draft, index, -1))} disabled={config.readOnly || index === 0}>
              <ArrowUp size={16} />
            </button>
            <button title="Move library down" onClick={() => setDraft(moveLibrary(draft, index, 1))} disabled={config.readOnly || index === draft.libraries.length - 1}>
              <ArrowDown size={16} />
            </button>
          </div>
          <input value={library.name} onChange={(event) => setDraft(updateLibrary(draft, index, { name: event.target.value }))} disabled={config.readOnly} />
          <input value={library.path} onChange={(event) => setDraft(updateLibrary(draft, index, { path: event.target.value }))} disabled={config.readOnly} />
          <label><input type="checkbox" checked={library.enabled} onChange={(event) => setDraft(updateLibrary(draft, index, { enabled: event.target.checked }))} disabled={config.readOnly} />Enabled</label>
          <label><input type="checkbox" checked={library.startExpanded !== false} onChange={(event) => setDraft(updateLibrary(draft, index, { startExpanded: event.target.checked }))} disabled={config.readOnly} />Start expanded</label>
        </div>
      ))}
      <button onClick={() => setDraft({ ...draft, libraries: [...draft.libraries, { id: crypto.randomUUID(), name: 'Library', path: '', enabled: true, startExpanded: true }] })} disabled={config.readOnly}>Add library</button>
      <button onClick={() => void onSaved(draft)} disabled={config.readOnly}>Save settings</button>
    </section>
  );
}

function updateLibrary(settings: AppSettings, index: number, patch: Partial<AppSettings['libraries'][number]>): AppSettings {
  return { ...settings, libraries: settings.libraries.map((library, current) => (current === index ? { ...library, ...patch } : library)) };
}

function moveLibrary(settings: AppSettings, index: number, offset: -1 | 1): AppSettings {
  const target = index + offset;
  if (target < 0 || target >= settings.libraries.length) return settings;
  const libraries = [...settings.libraries];
  [libraries[index], libraries[target]] = [libraries[target], libraries[index]];
  return { ...settings, libraries };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) };
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? 'Request failed');
  return payload.data as T;
}

function absoluteUrl(pathname: string): string {
  return new URL(pathname, window.location.origin).toString();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function isSlideshowItem(item: MediaItem): boolean {
  return item.kind === 'image' || item.kind === 'video';
}

function nearbySlideshowItems(items: MediaItem[], index: number, radius: number): MediaItem[] {
  if (items.length === 0) return [];
  const safeIndex = clampNumber(index, 0, items.length - 1);
  const nearby = new Map<string, MediaItem>();
  for (let offset = -radius; offset <= radius; offset += 1) {
    const item = items[(safeIndex + offset + items.length) % items.length];
    if (item) nearby.set(item.id, item);
  }
  return Array.from(nearby.values());
}

function orderItemsByIds(items: MediaItem[], ids: string[]): MediaItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = ids.map((id) => byId.get(id)).filter((item): item is MediaItem => Boolean(item));
  const orderedIds = new Set(ordered.map((item) => item.id));
  return [...ordered, ...items.filter((item) => !orderedIds.has(item.id))];
}

function reconcileShuffleIds(currentIds: string[], itemIds: string[]): string[] {
  const visible = new Set(itemIds);
  const kept = currentIds.filter((id) => visible.has(id));
  const keptSet = new Set(kept);
  const added = shuffleArray(itemIds.filter((id) => !keptSet.has(id)));
  return [...kept, ...added];
}

function shuffleArray<T>(values: T[]): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function imageItemSize(item: MediaItem): Size | null {
  return item.width && item.height ? { width: item.width, height: item.height } : null;
}

function mediaAspectRatio(item: MediaItem): string {
  return item.width && item.height ? `${item.width} / ${item.height}` : '1 / 1';
}

function mediaKindLabel(item: MediaItem): string {
  if (item.kind === 'video') return 'Video';
  if (item.kind === 'text') return 'Text';
  return 'File';
}

function isMarkdownItem(item: MediaItem): boolean {
  return item.extension.toLowerCase() === 'md';
}

function stripMarkdownFrontmatter(source: string): string {
  return source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

function renderMarkdownHtml(source: string): string {
  const html = marked.parse(source, {
    async: false,
    breaks: true,
    gfm: true,
  });
  return DOMPurify.sanitize(html);
}

function detailImageBox(image: Size, preview: Size, mode: DetailFitMode): { width: string; height: string } {
  const imageRatio = image.width / image.height || 1;
  const previewRatio = preview.width / preview.height || 1;
  const fitByWidth = mode === 'contain' ? imageRatio >= previewRatio : imageRatio < previewRatio;
  const width = fitByWidth ? preview.width : preview.height * imageRatio;
  const height = fitByWidth ? preview.width / imageRatio : preview.height;
  return {
    width: `${Math.max(1, Math.round(width))}px`,
    height: `${Math.max(1, Math.round(height))}px`,
  };
}

function canDropOnFolder(dataTransfer: DataTransfer, target: FolderNode): boolean {
  if (dataTransfer.types.includes('application/x-onefolder-media')) return true;
  const rawFolder = dataTransfer.getData('application/x-onefolder-folder');
  if (!rawFolder) return dataTransfer.types.includes('application/x-onefolder-folder');
  const folder = parseDraggedFolder(rawFolder);
  return Boolean(folder && canMoveFolderTo(folder, target));
}

function canMoveFolderTo(folder: DraggedFolder, target: FolderNode): boolean {
  if (!folder.path) return false;
  if (folder.libraryId !== target.libraryId) return true;
  return !isSameOrChildFolder(target.relativePath, folder.path);
}

function isSameOrChildFolder(value: string, parent: string): boolean {
  return value === parent || value.startsWith(`${parent}/`);
}

function parseDraggedFolder(value: string): DraggedFolder | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<DraggedFolder>;
    return parsed.libraryId && parsed.path ? { libraryId: parsed.libraryId, path: parsed.path } : undefined;
  } catch {
    return undefined;
  }
}

function updateFavicon(siteImageUrl: string) {
  if (!siteImageUrl) return;
  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link');
  favicon.rel = 'icon';
  favicon.href = siteImageUrl;
  if (!favicon.parentElement) document.head.appendChild(favicon);
}

function triggerDownload(url: string, filename?: string) {
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function writeTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

async function mediaItemToPngBlob(item: MediaItem): Promise<Blob> {
  const blob = await fetch(item.fileUrl).then((response) => response.blob());
  return blobToPngBlob(blob);
}

async function tryWriteClipboardItems(items: ClipboardItem[]): Promise<boolean> {
  try {
    await navigator.clipboard.write(items);
    return true;
  } catch (error) {
    console.warn('Multiple image clipboard write failed', error);
    return false;
  }
}

async function tryWriteEmbeddedImageHtml(items: MediaItem[]): Promise<boolean> {
  try {
    const dataUrls = await Promise.all(items.map((item) => mediaItemToDataUrl(item)));
    const html = `<div>${dataUrls.map((url) => `<img src="${url}" />`).join('')}</div>`;
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ]);
    return true;
  } catch (error) {
    console.warn('Embedded HTML image clipboard write failed', error);
    return false;
  }
}

async function mediaItemToDataUrl(item: MediaItem): Promise<string> {
  const blob = await mediaItemToPngBlob(item);
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Could not read image')));
    reader.readAsDataURL(blob);
  });
}

async function blobToPngBlob(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(bitmap, 0, 0);
  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Could not encode image'))), 'image/png');
  });
  bitmap.close();
  return pngBlob;
}

function exportAspectRatio(aspect: ExportAspect, width: number, height: number): number {
  if (aspect === '16:9') return 16 / 9;
  if (aspect === '16:10') return 16 / 10;
  if (aspect === '1:1') return 1;
  return width / height || 1;
}

function defaultCropForAspect(aspect: ExportAspect, width: number, height: number): CropRect {
  const ratio = exportAspectRatio(aspect, width, height);
  const currentRatio = width / height;
  if (aspect === 'original' || Math.abs(currentRatio - ratio) < 0.001) return { x: 0, y: 0, width: 1, height: 1 };
  if (currentRatio > ratio) {
    const cropWidth = ratio / currentRatio;
    return { x: (1 - cropWidth) / 2, y: 0, width: cropWidth, height: 1 };
  }
  const cropHeight = currentRatio / ratio;
  return { x: 0, y: (1 - cropHeight) / 2, width: 1, height: cropHeight };
}

function constrainCrop(crop: CropRect): CropRect {
  return {
    ...crop,
    x: Math.min(Math.max(0, crop.x), 1 - crop.width),
    y: Math.min(Math.max(0, crop.y), 1 - crop.height),
  };
}

function resizeCropFromAnchor(anchorX: number, anchorY: number, pointerX: number, pointerY: number, handle: CropHandle, ratio: number): CropRect {
  const horizontalSize = Math.abs(pointerX - anchorX);
  const verticalSize = Math.abs(pointerY - anchorY);
  const maxWidth = handle.includes('w') ? anchorX : 1 - anchorX;
  const maxHeight = handle.includes('n') ? anchorY : 1 - anchorY;
  const maxRatioWidth = Math.max(0.001, Math.min(maxWidth, maxHeight * ratio));
  const minWidth = Math.min(0.05, maxRatioWidth);
  const targetWidth = Math.max(horizontalSize, verticalSize * ratio);
  const width = Math.max(minWidth, Math.min(targetWidth, maxRatioWidth));
  const height = width / ratio;
  return constrainCrop({
    x: handle.includes('w') ? anchorX - width : anchorX,
    y: handle.includes('n') ? anchorY - height : anchorY,
    width,
    height,
  });
}

async function exportScaledImage(item: MediaItem, width: number, height: number, crop: CropRect): Promise<void> {
  const blob = await fetch(item.fileUrl).then((response) => response.blob());
  const bitmap = await createImageBitmap(blob);
  const source = cropToSourceRect(crop, bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
  const type = item.mimeType === 'image/jpeg' || item.mimeType === 'image/jpg' ? 'image/jpeg' : 'image/png';
  const exported = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error('Could not export image'))), type, 0.92);
  });
  bitmap.close();
  const extension = type === 'image/jpeg' ? 'jpg' : 'png';
  const url = URL.createObjectURL(exported);
  triggerDownload(url, `${fileBaseName(item.name)}-${canvas.width}x${canvas.height}.${extension}`);
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function cropToSourceRect(crop: CropRect, width: number, height: number): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(crop.x * width),
    y: Math.round(crop.y * height),
    width: Math.max(1, Math.round(crop.width * width)),
    height: Math.max(1, Math.round(crop.height * height)),
  };
}

function fileBaseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_') || 'export';
}


function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value > 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function hasExternalFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files') && !dataTransfer.types.includes('application/x-onefolder-media');
}

function clipboardImageFiles(dataTransfer: DataTransfer | null): File[] {
  if (!dataTransfer) return [];
  const files = Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
  const sourceFiles = files.length > 0 ? files : Array.from(dataTransfer.files).filter((file) => file.type.startsWith('image/'));
  return sourceFiles.map(normalizeClipboardImageFile);
}

function normalizeClipboardImageFile(file: File, index: number): File {
  const name = file.name.trim();
  if (name && !/^image(?:\.[a-z0-9]+)?$/i.test(name)) return file;
  return new File([file], clipboardImageFileName(file, index), {
    type: file.type || 'image/png',
    lastModified: file.lastModified || Date.now(),
  });
}

function clipboardImageFileName(file: File, index: number): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const suffix = index === 0 ? '' : `-${index + 1}`;
  return `clipboard-${stamp}${suffix}.${imageExtensionForType(file.type, file.name)}`;
}

function imageExtensionForType(type: string, name: string): string {
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  if (extension && /^[a-z0-9]+$/.test(extension)) return extension === 'jpeg' ? 'jpg' : extension;
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/svg+xml') return 'svg';
  return type.split('/').at(1)?.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
}

function normalizeTag(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s*(?:->|>|\\|\|\/|\|)\s*/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .replace(/^\/+|\/+$/g, '')
    .trim()
    .toLowerCase();
}

function displayTag(tag: string): string {
  const normalized = normalizeTag(tag);
  return normalized.split('/').at(-1) ?? normalized;
}

function displayTags(tags: string[]): string {
  return tags.map(displayTag).filter(Boolean).join(', ');
}

function expandTagPathAncestors(tags: string[]): string[] {
  const expanded = new Set<string>();
  tags.map(normalizeTag).filter(Boolean).forEach((tag) => {
    const parts = tag.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      expanded.add(parts.slice(0, index + 1).join('/'));
    }
  });
  return Array.from(expanded);
}

function resolveTagAlias(tag: string, aliases: Record<string, string[]>): string {
  const normalized = normalizeTag(tag);
  if (!normalized) return '';
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    const cleanCanonical = normalizeTag(canonical);
    if (!cleanCanonical) continue;
    if (cleanCanonical === normalized || aliasList.map(normalizeTag).includes(normalized)) return cleanCanonical;
  }
  return normalized;
}

function buildTagTree(tags: string[]): TagTreeNode[] {
  const roots: TagTreeNode[] = [];
  const byPath = new Map<string, TagTreeNode>();

  tags.map(normalizeTag).filter(Boolean).forEach((tag) => {
    const parts = tag.split('/');
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      if (byPath.has(path)) return;
      const node: TagTreeNode = { path, name: part, children: [] };
      byPath.set(path, node);
      if (index === 0) {
        roots.push(node);
      } else {
        const parent = byPath.get(parts.slice(0, index).join('/'));
        parent?.children.push(node);
      }
    });
  });

  const sortNodes = (nodes: TagTreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(roots);
  return roots;
}

function buildTagSummaryTree(summaries: TagSummary[]): TagSummaryTreeNode[] {
  const roots: TagSummaryTreeNode[] = [];
  const byPath = new Map<string, TagSummaryTreeNode>();
  const counts = new Map<string, number>();

  summaries.forEach((summary) => {
    const tag = normalizeTag(summary.tag);
    if (tag) counts.set(tag, summary.count);
  });

  counts.forEach((_count, tag) => {
    const parts = tag.split('/');
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      if (byPath.has(path)) return;
      const node: TagSummaryTreeNode = {
        tag: path,
        name: part,
        count: counts.get(path) ?? 0,
        children: [],
      };
      byPath.set(path, node);
      if (index === 0) {
        roots.push(node);
      } else {
        byPath.get(parts.slice(0, index).join('/'))?.children.push(node);
      }
    });
  });

  return roots;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debounced;
}
