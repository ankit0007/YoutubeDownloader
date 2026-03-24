# YouTube Downloader Queue App

Simple browser-based app where you can paste YouTube links, add multiple videos to queue, and download them in highest quality by fetching best video and audio streams separately, then merging with ffmpeg.

## Features

- Browser UI with URL textbox
- Add multiple YouTube links into queue
- Automatic one-by-one downloading
- Progress updates and final download button
- Pause, resume, and cancel for active downloads
- Persistent queue in SQLite (`queue.db`)

## Run

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start app:

   ```bash
   npm start
   ```

3. Open in browser:

   ```text
   http://localhost:3000
   ```

## Notes

- Downloads are saved in `downloads/` directory.
- Temporary chunk files are saved in `downloads/temp` and cleaned automatically.
- Queue state survives server restarts using SQLite database `queue.db`.
