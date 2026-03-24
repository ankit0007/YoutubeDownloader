const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const sqlite3 = require("sqlite3").verbose();
const ytdl = require("@distube/ytdl-core");
const ffmpegPath = require("ffmpeg-static");

const app = express();
const PORT = process.env.PORT || 3000;

const downloadsDir = path.join(__dirname, "downloads");
const tempDir = path.join(downloadsDir, "temp");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const db = new sqlite3.Database(path.join(__dirname, "queue.db"));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(downloadsDir));

let queue = [];
let isProcessing = false;
let currentTask = null;

function runDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      return resolve(this);
    });
  });
}

function allDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      return resolve(rows);
    });
  });
}

function sanitizeFileName(input) {
  return input.replace(/[<>:"/\\|?*]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function toItem(row) {
  return {
    id: row.id,
    url: row.url,
    title: row.title || "",
    filename: row.filename || "",
    status: row.status,
    progress: row.progress || 0,
    message: row.message || "",
    downloadUrl: row.downloadUrl || ""
  };
}

async function loadQueue() {
  await runDb(
    `CREATE TABLE IF NOT EXISTS queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT DEFAULT '',
      filename TEXT DEFAULT '',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      downloadUrl TEXT DEFAULT '',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runDb(
    "UPDATE queue_items SET status = 'queued', message = 'Resuming after restart...' WHERE status IN ('downloading', 'merging')"
  );
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id ASC");
  queue = rows.map(toItem);
}

async function persistItem(item) {
  await runDb(
    `UPDATE queue_items
     SET title = ?, filename = ?, status = ?, progress = ?, message = ?, downloadUrl = ?
     WHERE id = ?`,
    [item.title, item.filename, item.status, item.progress, item.message, item.downloadUrl, item.id]
  );
}

async function refreshQueueFromDb() {
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id ASC");
  queue = rows.map(toItem);
}

function getNextQueueItem() {
  return queue.find((item) => item.status === "queued");
}

function cleanupTempFiles(videoPath, audioPath) {
  if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
}

async function downloadStreamToFile({
  info,
  format,
  outputPath,
  onProgress,
  registerStream
}) {
  return new Promise((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, { format });
    const fileWriteStream = fs.createWriteStream(outputPath);

    registerStream(stream);

    stream.on("progress", (_chunkLength, downloaded, total) => {
      if (total > 0) onProgress(downloaded, total);
    });
    stream.on("error", (err) => reject(err));
    fileWriteStream.on("error", (err) => reject(err));
    fileWriteStream.on("finish", () => resolve());
    stream.pipe(fileWriteStream);
  });
}

async function mergeWithFfmpeg(videoPath, audioPath, outputPath, item) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg not found. Install/resolve ffmpeg-static.");
  }

  item.status = "merging";
  item.message = "Merging best video + audio...";
  item.progress = Math.max(item.progress, 90);
  await persistItem(item);

  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, [
      "-y",
      "-i",
      videoPath,
      "-i",
      audioPath,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      outputPath
    ]);

    currentTask.ffmpegProcess = ffmpeg;
    ffmpeg.on("error", (err) => reject(err));
    ffmpeg.on("close", (code) => {
      currentTask.ffmpegProcess = null;
      if (code !== 0) {
        return reject(new Error(`ffmpeg exited with code ${code}`));
      }
      item.progress = 100;
      return resolve();
    });
  });
}

async function processQueue() {
  if (isProcessing) return;
  const item = getNextQueueItem();
  if (!item) return;

  isProcessing = true;
  let videoTempPath = "";
  let audioTempPath = "";

  try {
    item.status = "downloading";
    item.message = "Fetching video info...";
    item.progress = 0;
    await persistItem(item);

    const info = await ytdl.getInfo(item.url);
    const videoFormat = ytdl.chooseFormat(info.formats.filter((f) => f.hasVideo && !f.hasAudio), {
      quality: "highestvideo"
    });
    const audioFormat = ytdl.chooseFormat(info.formats.filter((f) => f.hasAudio && !f.hasVideo), {
      quality: "highestaudio"
    });

    if (!videoFormat || !audioFormat) {
      throw new Error("Best separate video/audio formats not available.");
    }

    const safeTitle = sanitizeFileName(info.videoDetails.title || "video");
    const baseName = `${safeTitle}_${item.id}`;
    const outputFilename = `${baseName}.mp4`;
    const outputPath = path.join(downloadsDir, outputFilename);

    videoTempPath = path.join(tempDir, `${baseName}.video.mp4`);
    audioTempPath = path.join(tempDir, `${baseName}.audio.webm`);
    item.title = info.videoDetails.title;
    item.filename = outputFilename;
    item.message = "Downloading best video stream...";
    item.progress = 1;
    await persistItem(item);

    currentTask = {
      itemId: item.id,
      videoStream: null,
      audioStream: null,
      ffmpegProcess: null,
      canceled: false,
      paused: false
    };

    let videoPart = 0;
    let audioPart = 0;
    const updateCombinedProgress = async () => {
      item.progress = Math.min(89, Math.round(videoPart * 45 + audioPart * 45));
      await persistItem(item);
    };

    await downloadStreamToFile({
      info,
      format: videoFormat,
      outputPath: videoTempPath,
      onProgress: async (downloaded, total) => {
        videoPart = downloaded / total;
        await updateCombinedProgress();
      },
      registerStream: (stream) => {
        currentTask.videoStream = stream;
      }
    });

    if (currentTask.canceled) throw new Error("Download cancelled");

    item.message = "Downloading best audio stream...";
    await persistItem(item);

    await downloadStreamToFile({
      info,
      format: audioFormat,
      outputPath: audioTempPath,
      onProgress: async (downloaded, total) => {
        audioPart = downloaded / total;
        await updateCombinedProgress();
      },
      registerStream: (stream) => {
        currentTask.audioStream = stream;
      }
    });

    if (currentTask.canceled) throw new Error("Download cancelled");

    await mergeWithFfmpeg(videoTempPath, audioTempPath, outputPath, item);
    item.status = "completed";
    item.message = "Download completed";
    item.downloadUrl = `/downloads/${encodeURIComponent(outputFilename)}`;
    await persistItem(item);
  } catch (err) {
    if (item.status !== "paused") {
      item.status = "failed";
      item.message = err.message || "Download failed";
      await persistItem(item);
    }
  } finally {
    cleanupTempFiles(videoTempPath, audioTempPath);
    currentTask = null;
    isProcessing = false;
    await refreshQueueFromDb();
    processQueue();
  }
}

app.post("/api/queue", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string" || !ytdl.validateURL(url)) {
      return res.status(400).json({ error: "Please provide a valid YouTube URL." });
    }

    const result = await runDb(
      "INSERT INTO queue_items (url, status, progress, message) VALUES (?, 'queued', 0, 'Waiting in queue...')",
      [url.trim()]
    );
    const rows = await allDb("SELECT * FROM queue_items WHERE id = ?", [result.lastID]);
    const item = toItem(rows[0]);
    queue.push(item);
    processQueue();
    return res.status(201).json(item);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not add video." });
  }
});

app.get("/api/queue", async (_req, res) => {
  await refreshQueueFromDb();
  res.json(queue);
});

app.post("/api/queue/:id/action", async (req, res) => {
  const id = Number(req.params.id);
  const { action } = req.body || {};
  const item = queue.find((q) => q.id === id);
  if (!item) return res.status(404).json({ error: "Queue item not found." });

  if (!["pause", "resume", "cancel"].includes(action)) {
    return res.status(400).json({ error: "Invalid action." });
  }

  if (action === "pause") {
    if (!currentTask || currentTask.itemId !== id) {
      return res.status(400).json({ error: "Only current download can be paused." });
    }
    if (item.status === "merging") {
      return res.status(400).json({ error: "Pause during merge is not supported." });
    }
    if (currentTask.videoStream) currentTask.videoStream.pause();
    if (currentTask.audioStream) currentTask.audioStream.pause();
    currentTask.paused = true;
    item.status = "paused";
    item.message = "Paused by user";
    await persistItem(item);
    return res.json(item);
  }

  if (action === "resume") {
    if (item.status === "paused" && currentTask && currentTask.itemId === id) {
      if (currentTask.videoStream) currentTask.videoStream.resume();
      if (currentTask.audioStream) currentTask.audioStream.resume();
      currentTask.paused = false;
      item.status = "downloading";
      item.message = "Resumed...";
      await persistItem(item);
      return res.json(item);
    }

    if (item.status === "paused") {
      item.status = "queued";
      item.message = "Resumed to queue";
      await persistItem(item);
      processQueue();
      return res.json(item);
    }

    return res.status(400).json({ error: "Only paused item can be resumed." });
  }

  if (action === "cancel") {
    if (currentTask && currentTask.itemId === id) {
      currentTask.canceled = true;
      if (currentTask.videoStream) currentTask.videoStream.destroy(new Error("Canceled by user"));
      if (currentTask.audioStream) currentTask.audioStream.destroy(new Error("Canceled by user"));
      if (currentTask.ffmpegProcess) currentTask.ffmpegProcess.kill("SIGTERM");
    }
    item.status = "cancelled";
    item.message = "Cancelled by user";
    await persistItem(item);
    return res.json(item);
  }

  return res.status(400).json({ error: "Unsupported action." });
});

app.delete("/api/queue/:id", async (req, res) => {
  const id = Number(req.params.id);
  const item = queue.find((q) => q.id === id);
  if (!item) return res.status(404).json({ error: "Queue item not found." });
  if (item.status === "downloading" || item.status === "merging") {
    return res.status(400).json({ error: "Use cancel for active download." });
  }

  await runDb("DELETE FROM queue_items WHERE id = ?", [id]);
  await refreshQueueFromDb();
  return res.status(204).send();
});

loadQueue()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`YouTube downloader running at http://localhost:${PORT}`);
    });
    processQueue();
  })
  .catch((err) => {
    console.error("Failed to start app:", err);
    process.exit(1);
  });
