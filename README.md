# YouTube Downloader Pro

Browser-based YouTube downloader with quality buttons, MP3 support, a persistent SQLite queue, and a card grid UI with thumbnails and inline preview.

## Features

- **Tabs:** **One link** (single URL + Load Options) and **Multiple URLs** (bulk list + optional quality chips from the first URL).
- **Single URL:** Paste a link → **Load Options** → pick a **Video** quality chip or **Audio MP3 (Best)**.
- **Multiple URLs:** On the **Multiple URLs** tab, paste one URL per line → **Queue all · Video (best)** / **MP3**, or **Load quality options (first URL in list)** then use chips to queue **all lines** at that quality.
- **Queue:** Up to **5** concurrent downloads, live progress, **latest items first**.
- **Bulk actions:** Checkbox on each card, **Select all**, **Remove selected**, **Download selected** (staggered browser downloads for completed files).
- **Remove:** Per-item or bulk — choose app-only vs **also delete file** on disk.
- **Preview:** Play video or audio inside the card; opening another preview closes others.
- **Sync:** If a **completed** file is removed from `downloads/`, the queue row is dropped on the next queue refresh.
- **Persistence:** Queue stored in `queue.db` (SQLite).

## Tech stack

- Node.js + Express
- `yt-dlp-exec` (YouTube downloads / metadata; uses Node JS runtime for extraction)
- `ffmpeg-static` (MP3 / merge paths)
- `@distube/ytdl-core` (URL validation and video ID)
- `sqlite3`
- Vanilla HTML / CSS / JS in `public/`

## Requirements

- Node.js **18+** (recommended)
- Network access
- Legal use only — respect YouTube’s terms and copyright in your jurisdiction.

## Setup

```bash
npm install
npm start
```

Default URL:

```text
http://localhost:3000
```

Optional port:

```bash
set PORT=4000
npm start
```

(On Unix: `PORT=4000 npm start`.)

## Desktop app (Windows)

Same UI as the web app, inside an Electron window. Downloads and `queue.db` are stored under the app userData folder when running as desktop/MSI (`%APPDATA%\YouTube Downloader Pro\`).

### Run desktop (dev)

```bash
npm install
npm run electron
```

### Build MSI installer

```bash
npm run dist:msi
```

On Windows PowerShell, if code-signing tools complain about symlinks, run:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY='false'
npm run dist:msi
```

Output (examples):

```text
dist/YouTube Downloader Pro-1.0.0-Setup.msi
dist/YouTube Downloader Pro-1.0.0-Setup.exe
```

- **`.msi`** — Windows Installer package  
- **`.exe`** — NSIS setup (same app; useful if MSI is blocked by policy)

Install, then launch **YouTube Downloader Pro** from the Start Menu or desktop shortcut.

Notes:

- First build may take several minutes (Electron + WiX/NSIS downloads).
- Web mode still works with `npm start` in a browser.
- Optional: replace `build/icon.ico` (include a 256×256 size) to customize the app icon.
- Stop any running instance of the app before building (native `sqlite3` rebuild needs an unlocked binary).

## Usage

1. **One video:** **One link** tab → paste URL → **Load Options** → choose a quality or MP3.
2. **Many URLs:** **Multiple URLs** tab → paste lines → **Queue all** or load qualities from the first line, then use chips.
3. Watch the queue; use **Download Only** / **Download selected** when **Completed**; **Remove** / **Cancel** as needed.

## File naming

Videos (under `downloads/`):

- `videoId_<quality>.mp4` — e.g. `_360`, `_1080`, `_best`

MP3:

- `videoId.mp3`

## HTTP API (overview)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/queue` | Full queue (refreshes from DB, prunes missing completed files) |
| `POST` | `/api/queue` | Add one item `{ url, qualityPreference?, downloadType? }` |
| `POST` | `/api/queue/bulk` | Add up to 50 items `{ items: [{ url, qualityPreference?, downloadType? }] }` |
| `POST` | `/api/queue/bulk-delete` | `{ ids: number[], deleteFile: boolean }` |
| `DELETE` | `/api/queue/:id?deleteFile=true` or `false` | Remove one item |
| `POST` | `/api/queue/:id/action` | `{ action: "cancel" }` (others may return 400) |
| `POST` | `/api/formats` | `{ url }` → title + quality list for the UI |

## Queue rules

- Duplicate **active** job blocked: same `videoId` + `downloadType` + `qualityPreference` while queued/downloading/merging/paused.
- Different qualities (or MP3 vs video) for the same video are separate jobs.
- Server must stay running for downloads to finish if the browser is closed.

## Git / local data

`.gitignore` includes `node_modules/`, `downloads/`, and `queue.db`. Clone fresh → run `npm install` → start; queue and files are local only.

## License

MIT (see `package.json`).
