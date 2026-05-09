# OneFolder Web

A self-hosted web version of the OneFolder idea: your image and video files stay in ordinary folders, thumbnails and JSON backups live in persistent storage, and tags/descriptions are written back through XMP metadata.

## Capabilities

- Multiple libraries configured in the web settings panel.
- Nested `Library/Artist/Subfolder` browsing, folder creation, and drag-and-drop upload.
- List, grid, vertical masonry, horizontal masonry, and calendar views.
- Real-time filters for filename, folder, description, artist, and tags.
- Single or bulk XMP tagging, plus description edits.
- Hierarchical tag catalog management, including branch rename and removal.
- Detail view by double-clicking or pressing Enter after selecting an item.
- `Ctrl+C`/`Cmd+C` copies selected media through the browser clipboard when supported, with link fallback.
- Share-link copy for a media item or the current filter state with UTM query parameters.
- Soft delete moves files to a persistent trash folder instead of deleting from disk.
- Filesystem scanning for direct uploads and thumbnail creation.
- Public-instance controls through `READ_ONLY`, `BLACKLISTED_TAGS`, and `HIDE_EMPTY_FOLDERS`.

## Docker

```bash
docker compose up --build
```

Open [http://localhost:4317](http://localhost:4317).

Persistent volumes:

- `/data/library`: source images and videos
- `/data/settings`: settings and media index JSON
- `/data/thumbnails`: generated thumbnails
- `/data/backups`: timestamped JSON backups
- `/data/trash`: soft-deleted media, preserving library-relative paths

Environment variables:

- `READ_ONLY=true`: disables uploads, folder creation, settings edits, and metadata writes.
- `DEFAULT_READ_ONLY_VIEW=masonry-vertical`: first view used for read-only visitors. Supports `list`, `grid`, `masonry-vertical`, `masonry-horizontal`, and `calendar`.
- `BLACKLISTED_TAGS=AI,artist-name`: hides any media with one of these tags.
- `HIDE_EMPTY_FOLDERS=true`: prunes empty folder branches from the UI.
- `MAX_UPLOAD_MB=250`: per-file upload limit.
- `SCAN_INTERVAL_MS=15000`: periodic filesystem scan interval.
- `TRASH_DIR=/data/trash`: where soft-deleted files are moved.

## Local Development

```bash
npm install
npm run dev
```

The development server serves both the API and Vite UI at [http://localhost:4317](http://localhost:4317).

## Versioning

This project uses semantic versioning from `package.json`. The Docker workflow publishes tags for pushed semver tags such as `v0.1.0`, plus `latest` from `main`.
