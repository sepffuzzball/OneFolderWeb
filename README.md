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
- Single-file downloads, multi-select ZIP downloads, and scaled/cropped image exports.
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

For Kubernetes, mount a single PVC at `/data` when the storage backend is NFS or CephFS. The app creates and uses the subdirectories above; avoid mounting additional volumes at nested paths such as `/data/backups` or `/data/trash` under the same PVC mount.

Environment variables:

- `SITE_NAME="Reference Library"`: display name shown in the app header.
- `SITE_IMAGE_URL=https://example.com/icon.png`: image used for the sidebar mark and browser favicon. `FAVICON_URL` is also accepted as an alias.
- `HOST=0.0.0.0`: bind address for the web server. The default is `0.0.0.0` so other devices on your network can reach it; use `localhost` to restrict access to the local machine.
- `PORT=4317`: server port. Also update the Docker port mapping, for example `8080:8080`, if you change this in Docker.
- `READ_ONLY=true`: disables uploads, folder creation, settings edits, and metadata writes.
- `DEFAULT_READ_ONLY_VIEW=masonry-vertical`: first view used for read-only visitors. Supports `list`, `grid`, `masonry-vertical`, `masonry-horizontal`, and `calendar`.
- `BLACKLISTED_TAGS=AI,artist-name`: hides any media with one of these tags.
- `HIDE_EMPTY_FOLDERS=true`: prunes empty folder branches from the UI.
- `MAX_UPLOAD_MB=250`: per-file upload limit.
- `BACKUP_INTERVAL_HOURS=24`: maximum frequency for JSON backup files. The default keeps at most one backup file per day when content changes.
- `BACKUP_RETENTION_DAYS=90`: removes JSON backup files older than this many days. Use `0` to disable JSON backups.
- `SCAN_INTERVAL_MS=15000`: periodic filesystem scan interval.
- `TRASH_DIR=/data/trash`: where soft-deleted files are moved.

### Persistence

OneFolder Web uses a pluggable persistence driver. By default, all settings, saved searches, and the media index are stored in JSON files under `/data/settings`. You can switch to PostgreSQL by adding the Postgres Compose override.

Environment variables:

- `PERSISTENCE_DRIVER=json` (default) or `postgres`. The JSON driver stores data in `/data/settings`.
- `DATABASE_URL`: required only when `PERSISTENCE_DRIVER=postgres`. The full Postgres connection URI, including any SSL parameters such as `sslmode=require`. Never log, share, or commit this value.
- `POSTGRES_POOL_MAX=10` (default 10, range 1..100): maximum pool connections.
- `POSTGRES_IDLE_TIMEOUT_MS=10000` (default 10000ms, range 0..3600000): pool idle timeout.
- `POSTGRES_CONNECTION_TIMEOUT_MS=5000` (default 5000ms, range 1..3600000): connection timeout.

Migrations run automatically under an advisory lock on Postgres startup. With the JSON driver, no database connection is attempted.

Media files (original images, videos, thumbnails) remain in filesystem/network storage. Postgres stores only settings, saved searches, and the derived media index. One app instance is recommended because scanning and filesystem operations are not distributed.

### PostgreSQL Deployment

To run with Postgres instead of JSON, use the provided override:

```bash
docker compose -f docker-compose.yml -f docker-compose.postgres.yml up --build
```

Set a strong production password. The raw password can be set as an environment variable or in a `.env` file. The `DATABASE_URL` must URL-encode the password if it contains special characters (e.g. `@`, `:`, `%`). Use `encodeURIComponent()` or a similar function.

For local non-TLS deployments (the default), use `sslmode=disable`:
```bash
export POSTGRES_PASSWORD='yourstrongpassword'
export DATABASE_URL='postgresql://onefolder:yoururlencodedpassword@postgres/onefolder?sslmode=disable'
```

For TLS-enabled external Postgres, use `sslmode=require`:
```bash
export POSTGRES_PASSWORD='yourstrongpassword'
export DATABASE_URL='postgresql://onefolder:yoururlencodedpassword@postgres/onefolder?sslmode=require'
```

The password in `POSTGRES_PASSWORD` is the raw value; the password in `DATABASE_URL` must be URL-encoded (percent-encoded) if it contains special characters. For example, a password with `@` becomes `%40` in the URI.

#### Migration Runbook

To migrate existing JSON data to Postgres:

1. Back up your settings/media/thumbnails/trash directories.
2. Stop the app: `docker compose down`.
3. Start only the Postgres service: `docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres`.
4. Run the built import CLI in a one-off app container:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm onefolder-web npm run persistence:import-json
   ```

   This reads JSON files from `/data/settings`, checks their digest, and writes them to Postgres. It refuses to import if the data is nonempty or the digest has changed from the previous import.

5. Start the app: `docker compose -f docker-compose.yml -f docker-compose.postgres.yml up --build`.

The import is idempotent: running it again on unchanged JSON does nothing. Do not modify JSON files during the migration process.

For development, the source CLI script also works outside Docker:

```bash
npm run persistence:import-json:dev
```

#### Rollback / Export Runbook

To switch back from Postgres to JSON:

1. Stop the app: `docker compose -f docker-compose.yml -f docker-compose.postgres.yml down`.
2. Start only the Postgres service (ensure DB is reachable): `docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres`.
3. Run the export CLI in a one-off app container with both Compose files, after explicitly starting the postgres service:

    ```bash
    docker compose -f docker-compose.yml -f docker-compose.postgres.yml up -d postgres
    docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm onefolder-web npm run persistence:export-json
    ```

    This exports Postgres data (settings, media index, saved searches) to JSON files under `/data/settings` (the default output directory). You can also specify an absolute path:

    ```bash
    docker compose -f docker-compose.yml -f docker-compose.postgres.yml run --rm onefolder-web npm run persistence:export-json /data/settings/custom-export
    ```

    > **Warning:** Relative paths and container-only paths (e.g., `./output`) will disappear under `--rm`. Use an absolute path like `/data/settings/...`.

4. Back up your current JSON directory (`/data/settings`) to a timestamped archive.
5. Copy the exported `settings.json`, `index.json`, and `saved-searches.json` into `/data/settings`.
6. Set `PERSISTENCE_DRIVER=json` in the environment or remove the Postgres Compose override, then restart.

The original pre-import JSON becomes stale after Postgres-side changes (settings edits, saved search creation, media index updates). A fresh export is needed whenever you plan to switch back.

For development (using tsx source, not compiled):

```bash
npm run persistence:export-json:dev -- <output-dir>
```

## Local Development

```bash
npm install
npm run dev
```

The development server serves both the API and Vite UI at [http://localhost:4317](http://localhost:4317).

## Versioning

This project uses semantic versioning from `package.json`. On pushes to `main`, the release workflow increments the patch version by default, commits the updated `package.json` and `package-lock.json`, creates a matching git tag such as `v0.1.1`, and publishes Docker images to GitHub Container Registry with matching tags:

- `ghcr.io/<owner>/<repo>:0.1.1`
- `ghcr.io/<owner>/<repo>:0.1`
- `ghcr.io/<owner>/<repo>:latest`

You can also run the workflow manually and choose `patch`, `minor`, or `major`.
