# YouTube Downloader Pro

A browser-based YouTube downloader with quality selection, MP3 support, persistent queue, and modern grid UI with thumbnails.

## Features

- URL-based download flow with one-click quality option buttons
- Real source quality listing (example: `2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`)
- Download modes:
  - `Video`
  - `Audio MP3`
- Queue with up to `5` concurrent downloads
- Live progress updates in percentage
- Grid card queue view with thumbnail, status, and progress bar
- Downloaded items shown latest-first
- SQLite-based persistence (`queue.db`)
- Optional remove mode:
  - remove from app only
  - remove from app + delete associated file

## Tech Stack

- Node.js + Express
- `yt-dlp-exec`
- `ffmpeg-static`
- SQLite (`sqlite3`)
- Vanilla HTML/CSS/JS frontend

## Requirements

- Node.js `18+` (recommended)
- Internet connection

## Setup

```bash
npm install
npm start
```

Open in browser:

```text
http://localhost:3000
```

## Usage

1. Paste a YouTube URL.
2. Click `Load Options`.
3. Click any option button:
   - `Video <quality>`
   - `Audio MP3 (Best)`
4. Track progress in the queue grid cards.
5. Use `Download File` after completion.

## File Naming Rules

Video files are saved with selected quality suffix:

- `videoId_360.mp4`
- `videoId_720.mp4`
- `videoId_1080.mp4`
- `videoId_1440.mp4`
- `videoId_2160.mp4`
- `videoId_best.mp4` (when auto/best selected)

MP3 files:

- `videoId.mp3`

All files are saved in:

- `downloads/`

## Queue Behavior

- Active duplicate job (same `videoId` + same `type` + same `quality`) is blocked.
- Different qualities for same video can run as separate jobs.
- Downloads continue server-side even if browser closes (server must keep running).

## Notes

- Old/failed 0-byte test files can be safely deleted from `downloads/`.
- Use responsibly and follow YouTube terms and applicable copyright laws.
