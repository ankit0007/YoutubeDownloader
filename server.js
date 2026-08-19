const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const ytdl = require("@distube/ytdl-core");
const ffmpegStaticPath = require("ffmpeg-static");
const ytDlpFactory = require("yt-dlp-exec");
const { resolveAsarUnpackedPath, createEngine } = require("./lib/ytDlpEngine");

const ytDlpConstants = require(path.join(path.dirname(require.resolve("yt-dlp-exec")), "constants.js"));
const ffmpegPath = resolveAsarUnpackedPath(process.env.FFMPEG_BIN || ffmpegStaticPath);
const ytEngine = createEngine({
  bundledYtDlpPath: resolveAsarUnpackedPath(process.env.YOUTUBE_DL_PATH || ytDlpConstants.YOUTUBE_DL_PATH),
  ffmpegPath
});
let ytDlp = ytDlpFactory.create(ytEngine.binaryPath);
const METADATA_TIMEOUT_MS = 120000;
const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000;

const app = express();
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const MAX_CONCURRENT_DOWNLOADS = 5;
const SESSION_COOKIE_NAME = "yd_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "Test@162$$";
const GUEST_COOKIE_NAME = "yd_guest";
const GUEST_FREE_COMPLETED_LIMIT = Number(process.env.GUEST_FREE_LIMIT || 5);
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Writable data root (downloads + queue.db). Overridden by YD_DATA_DIR / startServer({ dataDir }). */
let dataRoot = process.env.YD_DATA_DIR ? path.resolve(process.env.YD_DATA_DIR) : __dirname;
let downloadsDir = path.join(dataRoot, "downloads");
let db = null;
let httpServer = null;
let listeningPort = null;
let serverBootstrapped = false;

function ensureDataPaths(dataDir) {
  if (dataDir) {
    dataRoot = path.resolve(dataDir);
    process.env.YD_DATA_DIR = dataRoot;
  } else if (process.env.YD_DATA_DIR) {
    dataRoot = path.resolve(process.env.YD_DATA_DIR);
  } else {
    dataRoot = __dirname;
  }
  downloadsDir = path.join(dataRoot, "downloads");
  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }
  const dbPath = path.join(dataRoot, "queue.db");
  if (!db) {
    db = new sqlite3.Database(dbPath);
  }
}

app.use(express.json());

function parseCookies(cookieHeader) {
  const parsed = {};
  if (!cookieHeader) return parsed;
  const parts = String(cookieHeader).split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = decodeURIComponent(part.slice(0, idx).trim());
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    parsed[key] = value;
  }
  return parsed;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || !session.expiresAt || session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function createSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

function createSession(username) {
  cleanupExpiredSessions();
  const token = createSessionToken();
  sessions.set(token, {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function createUserSession(user) {
  cleanupExpiredSessions();
  const token = createSessionToken();
  sessions.set(token, {
    userId: user.id,
    username: user.username,
    isAdmin: Boolean(user.isAdmin),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  return token;
}

function getAuthenticatedSession(req) {
  cleanupExpiredSessions();
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, session };
}

function setSessionCookie(res, token) {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
  );
}

function createGuestToken() {
  return crypto.randomBytes(16).toString("hex");
}

function setGuestCookie(res, token) {
  const maxAgeSeconds = 365 * 24 * 60 * 60;
  res.setHeader(
    "Set-Cookie",
    `${GUEST_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  );
}

function getOrCreateGuestId(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  const existing = cookies[GUEST_COOKIE_NAME];
  if (existing && /^[a-f0-9]{16,64}$/i.test(existing)) {
    return existing;
  }
  const token = createGuestToken();
  setGuestCookie(res, token);
  return token;
}

function requireAuth(req, res, next) {
  const auth = getAuthenticatedSession(req);
  if (!auth) {
    return res.status(401).json({ error: "Unauthorized. Please login first." });
  }
  req.authUser = auth.session.username;
  req.authUserId = auth.session.userId;
  req.authIsAdmin = Boolean(auth.session.isAdmin);
  return next();
}

function optionalIdentity(req, res, next) {
  const auth = getAuthenticatedSession(req);
  if (auth) {
    req.authUser = auth.session.username;
    req.authUserId = auth.session.userId;
    req.authIsAdmin = Boolean(auth.session.isAdmin);
    req.guestId = null;
    return next();
  }
  req.authUser = null;
  req.authUserId = 0;
  req.authIsAdmin = false;
  req.guestId = getOrCreateGuestId(req, res);
  return next();
}

let queue = [];
const activeTasks = new Map();
const trimmingJobs = new Set();

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  const normalizedUsername = String(username || "").trim().toLowerCase();
  const normalizedPassword = String(password || "");
  if (!normalizedUsername || !normalizedPassword) {
    return res.status(400).json({ error: "Username and password required." });
  }

  if (
    normalizedUsername === DEFAULT_ADMIN_USERNAME.toLowerCase() &&
    normalizedPassword === DEFAULT_ADMIN_PASSWORD
  ) {
    const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
    allDb("SELECT id, username, isAdmin FROM users WHERE username = ? LIMIT 1", [normalizedUsername])
      .then(async (rows) => {
        if (!rows.length) {
          const r = await runDb("INSERT INTO users (username, passwordHash, isAdmin) VALUES (?, ?, 1)", [
            normalizedUsername,
            passwordHash
          ]);
          return { id: r.lastID, username: normalizedUsername, isAdmin: true };
        }
        await runDb("UPDATE users SET isAdmin = 1, passwordHash = ? WHERE username = ?", [
          passwordHash,
          normalizedUsername
        ]);
        return { id: rows[0].id, username: normalizedUsername, isAdmin: true };
      })
      .then((user) => {
        const token = createUserSession(user);
        setSessionCookie(res, token);
        return res.json({ ok: true, username: user.username, isAdmin: true });
      })
      .catch((err) => res.status(500).json({ error: err.message || "Login failed." }));
    return;
  }

  allDb("SELECT id, username, passwordHash, isAdmin FROM users WHERE username = ? LIMIT 1", [
    normalizedUsername
  ])
    .then((rows) => {
      if (!rows.length) return null;
      const row = rows[0];
      const ok = bcrypt.compareSync(normalizedPassword, String(row.passwordHash || ""));
      if (!ok) return null;
      return {
        id: row.id,
        username: row.username,
        isAdmin: Boolean(row.isAdmin)
      };
    })
    .then((user) => {
      if (!user) {
        return res.status(401).json({ error: "Invalid username or password." });
      }
      const token = createUserSession(user);
      setSessionCookie(res, token);
      return res.json({ ok: true, username: user.username, isAdmin: Boolean(user.isAdmin) });
    })
    .catch((err) => res.status(500).json({ error: err.message || "Login failed." }));
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const normalizedUsername = String(username || "").trim().toLowerCase();
    const normalizedPassword = String(password || "");
    if (!/^[a-z0-9._-]{3,30}$/.test(normalizedUsername)) {
      return res.status(400).json({ error: "Username must be 3-30 chars: a-z 0-9 . _ -" });
    }
    if (normalizedPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const existing = await allDb("SELECT id FROM users WHERE username = ? LIMIT 1", [normalizedUsername]);
    if (existing.length) {
      return res.status(409).json({ error: "Username already exists." });
    }

    const passwordHash = bcrypt.hashSync(normalizedPassword, 10);
    const r = await runDb(
      "INSERT INTO users (username, passwordHash, isAdmin) VALUES (?, ?, 0)",
      [normalizedUsername, passwordHash]
    );
    const rows = await allDb("SELECT id, username, isAdmin FROM users WHERE id = ? LIMIT 1", [r.lastID]);
    const user = rows[0];
    const token = createUserSession(user);
    setSessionCookie(res, token);
    return res.status(201).json({ ok: true, username: user.username, isAdmin: Boolean(user.isAdmin) });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Registration failed." });
  }
});

app.post("/api/auth/forgot", async (req, res) => {
  try {
    const { username } = req.body || {};
    const normalizedUsername = String(username || "").trim().toLowerCase();
    if (!normalizedUsername) return res.status(400).json({ error: "Username required." });
    const rows = await allDb("SELECT id FROM users WHERE username = ? LIMIT 1", [normalizedUsername]);
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const token = crypto.randomBytes(6).toString("hex").toUpperCase();
    const expiresAt = Date.now() + RESET_TOKEN_TTL_MS;
    await runDb("UPDATE users SET resetToken = ?, resetExpiresAt = ? WHERE username = ?", [
      token,
      String(expiresAt),
      normalizedUsername
    ]);
    // No email in this app; return token for local reset flow.
    return res.json({ ok: true, resetToken: token, expiresInMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000) });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Forgot password failed." });
  }
});

app.post("/api/auth/reset", async (req, res) => {
  try {
    const { username, resetToken, newPassword } = req.body || {};
    const normalizedUsername = String(username || "").trim().toLowerCase();
    const normalizedToken = String(resetToken || "").trim().toUpperCase();
    const normalizedPassword = String(newPassword || "");
    if (!normalizedUsername || !normalizedToken || !normalizedPassword) {
      return res.status(400).json({ error: "username, resetToken, newPassword required." });
    }
    if (normalizedPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    const rows = await allDb(
      "SELECT id, username, resetToken, resetExpiresAt, isAdmin FROM users WHERE username = ? LIMIT 1",
      [normalizedUsername]
    );
    if (!rows.length) return res.status(404).json({ error: "User not found." });
    const u = rows[0];
    const expiresAt = Number(u.resetExpiresAt || 0);
    if (!u.resetToken || String(u.resetToken).toUpperCase() !== normalizedToken || !expiresAt || expiresAt < Date.now()) {
      return res.status(400).json({ error: "Invalid or expired reset token." });
    }
    const passwordHash = bcrypt.hashSync(normalizedPassword, 10);
    await runDb("UPDATE users SET passwordHash = ?, resetToken = NULL, resetExpiresAt = NULL WHERE id = ?", [
      passwordHash,
      u.id
    ]);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Reset failed." });
  }
});

app.get("/api/auth/me", (req, res) => {
  const auth = getAuthenticatedSession(req);
  if (!auth) {
    return res.json({ authenticated: false });
  }
  return res.json({
    authenticated: true,
    username: auth.session.username,
    isAdmin: Boolean(auth.session.isAdmin)
  });
});

app.post("/api/auth/logout", (req, res) => {
  const auth = getAuthenticatedSession(req);
  if (auth) {
    sessions.delete(auth.token);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.use("/api", optionalIdentity);
app.use("/downloads", optionalIdentity);

function requireAdmin(req, res, next) {
  if (!req.authIsAdmin) {
    return res.status(403).json({ error: "Admin only." });
  }
  return next();
}

async function getGuestUsage(guestId) {
  if (!guestId) return { completedDownloads: 0, totalJobs: 0 };
  const rows = await allDb("SELECT completedDownloads, totalJobs FROM guest_usage WHERE guestId = ? LIMIT 1", [
    guestId
  ]);
  if (!rows.length) return { completedDownloads: 0, totalJobs: 0 };
  return {
    completedDownloads: Number(rows[0].completedDownloads || 0),
    totalJobs: Number(rows[0].totalJobs || 0)
  };
}

async function bumpGuestTotalJobs(guestId, by = 1) {
  if (!guestId) return;
  await runDb(
    "INSERT INTO guest_usage (guestId, completedDownloads, totalJobs) VALUES (?, 0, ?) ON CONFLICT(guestId) DO UPDATE SET totalJobs = totalJobs + ?",
    [guestId, Number(by) || 0, Number(by) || 0]
  );
}

async function recomputeGuestCompletedFromQueue(guestId) {
  if (!guestId) return;
  const rows = await allDb(
    "SELECT COUNT(id) as c FROM queue_items WHERE guestId = ? AND status = 'completed'",
    [guestId]
  );
  const c = Number(rows[0]?.c || 0);
  await runDb(
    "INSERT INTO guest_usage (guestId, completedDownloads, totalJobs) VALUES (?, ?, 0) ON CONFLICT(guestId) DO UPDATE SET completedDownloads = ?",
    [guestId, c, c]
  );
}

function withYtDlpDefaults(options = {}) {
  return ytEngine.commonFlags(options);
}

function lastUsefulError(stderrData, fallback) {
  const text = String(stderrData || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("[debug]"))
    .slice(-6)
    .join(" ");
  return text || fallback;
}

function spawnYtDlpProcess(url, options, { timeoutMs, onChunk, task } = {}) {
  return new Promise((resolve, reject) => {
    const argv = ytDlpFactory.args(url, withYtDlpDefaults(options));
    const child = spawn(ytEngine.binaryPath, argv, { windowsHide: true });
    if (task) task.ytDlpProcess = child;

    let stdoutData = "";
    let stderrData = "";
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (task) task.ytDlpProcess = null;
      fn(value);
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch (_err) {
            // ignore
          }
          finish(
            reject,
            new Error("YouTube request timed out. Check internet, then tap Retry.")
          );
        }, timeoutMs)
      : null;

    const onData = (chunk, isErr) => {
      const text = String(chunk || "");
      if (isErr) stderrData += text;
      else stdoutData += text;
      if (onChunk) onChunk(text);
    };

    if (child.stdout) child.stdout.on("data", (chunk) => onData(chunk, false));
    if (child.stderr) child.stderr.on("data", (chunk) => onData(chunk, true));
    child.on("error", (err) => finish(reject, err));
    child.on("close", (code) => {
      if (code !== 0) {
        return finish(
          reject,
          new Error(lastUsefulError(stderrData, `yt-dlp exited with code ${code}`))
        );
      }
      finish(resolve, { stdoutData, stderrData });
    });
  });
}

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

function isNonRemovableStatus(status) {
  return ["queued", "downloading", "merging", "paused", "trimming"].includes(status);
}

function parseQualityPreference(preference) {
  if (!preference || preference === "best") return null;
  const parsed = Number(preference);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeDownloadType(value) {
  const type = String(value || "video").toLowerCase();
  if (["video", "mp3"].includes(type)) return type;
  return "video";
}

function getQualitySuffix(qualityPreference) {
  if (!qualityPreference || qualityPreference === "best") return "best";
  if (/^\d+$/.test(String(qualityPreference))) return String(qualityPreference);
  return "best";
}

/** Parse MM:SS, HH:MM:SS, or plain seconds → total seconds, or null if empty/invalid. */
function parseTimeToSeconds(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }
  const parts = s.split(":").map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 2) {
    const [mm, ss] = nums;
    if (ss >= 60) return null;
    return mm * 60 + ss;
  }
  const [hh, mm, ss] = nums;
  if (mm >= 60 || ss >= 60) return null;
  return hh * 3600 + mm * 60 + ss;
}

function formatSecondsAsHms(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  if (h > 0) return `${pad(h)}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/**
 * Normalize optional trim. Empty both = no trim.
 * Returns { ok, error?, trimStart, trimEnd } where values are HH:MM:SS or MM:SS strings (or "").
 */
function normalizeTrimRange(trimStartRaw, trimEndRaw) {
  const startEmpty = trimStartRaw == null || String(trimStartRaw).trim() === "";
  const endEmpty = trimEndRaw == null || String(trimEndRaw).trim() === "";
  if (startEmpty && endEmpty) {
    return { ok: true, trimStart: "", trimEnd: "" };
  }
  const startSec = startEmpty ? 0 : parseTimeToSeconds(trimStartRaw);
  if (startSec === null) {
    return { ok: false, error: "Invalid trim start time. Use MM:SS, HH:MM:SS, or seconds." };
  }
  let endSec = null;
  if (!endEmpty) {
    endSec = parseTimeToSeconds(trimEndRaw);
    if (endSec === null) {
      return { ok: false, error: "Invalid trim end time. Use MM:SS, HH:MM:SS, or seconds." };
    }
    if (endSec <= startSec) {
      return { ok: false, error: "Trim end must be after trim start." };
    }
  }
  return {
    ok: true,
    trimStart: formatSecondsAsHms(startSec),
    trimEnd: endSec == null ? "" : formatSecondsAsHms(endSec)
  };
}

function getTrimFilenameSuffix(trimStart, trimEnd) {
  if (!trimStart && !trimEnd) return "";
  const startPart = String(trimStart || "0:00").replace(/:/g, "");
  const endPart = trimEnd ? String(trimEnd).replace(/:/g, "") : "end";
  return `_t${startPart}-${endPart}`;
}

/** yt-dlp --download-sections value, or null if no trim. */
function buildDownloadSections(trimStart, trimEnd) {
  if (!trimStart && !trimEnd) return null;
  const start = trimStart || "0:00";
  const end = trimEnd || "inf";
  return `*${start}-${end}`;
}

function withTrimYtDlpOptions(baseOptions, item) {
  const section = buildDownloadSections(item.trimStart, item.trimEnd);
  if (!section) return baseOptions;
  return {
    ...baseOptions,
    downloadSections: section,
    forceKeyframesAtCuts: true
  };
}

function resolveFfprobePath() {
  if (!ffmpegPath) return "";
  const dir = path.dirname(ffmpegPath);
  const candidates = [
    path.join(dir, "ffprobe.exe"),
    path.join(dir, "ffprobe"),
    path.join(dir, "..", "ffprobe.exe"),
    path.join(dir, "..", "ffprobe")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "";
}

function runProcess(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = "";
    let stdout = "";
    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk || "");
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk || "");
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      return reject(new Error(stderr || stdout || `Process exited with code ${code}`));
    });
  });
}

async function probeMediaDurationSeconds(filePath) {
  const probe = resolveFfprobePath();
  if (!probe) return null;
  try {
    const { stdout } = await runProcess(probe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath
    ]);
    const n = Number(String(stdout || "").trim());
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch (_err) {
    return null;
  }
}

async function ffmpegCutFile(inputPath, outputPath, startSec, endSec, isMp3) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg is not available.");
  }
  const startStr = formatSecondsAsHms(startSec);
  const endStr = formatSecondsAsHms(endSec);
  const copyArgs = [
    "-y",
    "-ss",
    startStr,
    "-to",
    endStr,
    "-i",
    inputPath,
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    outputPath
  ];
  try {
    await runProcess(ffmpegPath, copyArgs);
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
      return;
    }
  } catch (_err) {
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
      } catch (_e) {
        /* ignore */
      }
    }
  }

  const encodeArgs = isMp3
    ? [
        "-y",
        "-ss",
        startStr,
        "-to",
        endStr,
        "-i",
        inputPath,
        "-vn",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        outputPath
      ]
    : [
        "-y",
        "-ss",
        startStr,
        "-to",
        endStr,
        "-i",
        inputPath,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        outputPath
      ];
  await runProcess(ffmpegPath, encodeArgs);
  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 0) {
    throw new Error("Trim finished but output file is missing.");
  }
}

function findOwnedQueueItem(req, id) {
  const viewerId = req.authUserId || 0;
  const guestId = req.guestId || "";
  return queue.find((q) =>
    q.id === id
      ? viewerId
        ? Number(q.userId || 0) === Number(viewerId)
        : Number(q.userId || 0) === 0 && String(q.guestId || "") === String(guestId)
      : false
  );
}

function getVideoIdFromUrl(url) {
  try {
    return ytdl.getURLVideoID(url);
  } catch (_err) {
    return "";
  }
}

function canonicalizeYoutubeWatchUrl(url) {
  const videoId = getVideoIdFromUrl(url);
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
  return String(url || "").trim();
}

function qualityLabel(height) {
  if (height >= 4320) return `${height}p (8K)`;
  if (height >= 2160) return `${height}p (4K / Ultra HD)`;
  if (height >= 1440) return `${height}p (2K / QHD)`;
  if (height >= 1080) return `${height}p (Full HD)`;
  if (height >= 720) return `${height}p (HD)`;
  return `${height}p (SD)`;
}

function buildQualityOptionsFromMetadata(metadata) {
  const formats = Array.isArray(metadata?.formats) ? metadata.formats : [];
  const heights = new Set();
  for (const f of formats) {
    const hasVideo = f?.vcodec && f.vcodec !== "none";
    const height = Number(f?.height || 0);
    if (hasVideo && Number.isFinite(height) && height > 0) {
      heights.add(height);
    }
  }

  const options = Array.from(heights)
    .sort((a, b) => b - a)
    .map((height) => ({ value: String(height), label: qualityLabel(height) }));

  return [{ value: "best", label: "Best available (Auto)" }, ...options];
}

async function getVideoMetadataWithYtDlp(url) {
  const { stdoutData } = await spawnYtDlpProcess(
    url,
    {
      dumpSingleJson: true,
      skipDownload: true
    },
    { timeoutMs: METADATA_TIMEOUT_MS }
  );
  try {
    return JSON.parse(stdoutData);
  } catch (_err) {
    throw new Error("Failed to parse yt-dlp metadata output.");
  }
}

async function runYtDlpDumpJson(url, ytDlpOptions) {
  const { stdoutData } = await spawnYtDlpProcess(url, ytDlpOptions, { timeoutMs: METADATA_TIMEOUT_MS });
  try {
    return JSON.parse(stdoutData);
  } catch (_err) {
    throw new Error("Failed to parse yt-dlp JSON output.");
  }
}

function watchUrlFromFlatEntry(entry) {
  if (!entry || typeof entry !== "object") return "";
  const id = entry.id;
  if (typeof id === "string" && /^[\w-]{11}$/.test(id)) {
    return `https://www.youtube.com/watch?v=${id}`;
  }
  for (const key of ["url", "webpage_url"]) {
    const u = entry[key];
    if (typeof u === "string" && u.startsWith("http")) {
      const trimmed = u.trim();
      try {
        if (ytdl.validateURL(trimmed)) return trimmed;
        const vid = ytdl.getURLVideoID(trimmed);
        if (vid) return `https://www.youtube.com/watch?v=${vid}`;
      } catch (_e) {
        /* continue */
      }
    }
  }
  return "";
}

function extractWatchUrlsFromFlatJson(json) {
  if (!json || typeof json !== "object") return [];
  const entries = Array.isArray(json.entries) ? json.entries : [];
  if (entries.length > 0) {
    const out = [];
    for (const e of entries) {
      const w = watchUrlFromFlatEntry(e);
      if (w) out.push(w);
    }
    return out;
  }
  const single = watchUrlFromFlatEntry(json);
  return single ? [single] : [];
}

function dedupeWatchUrlsPreserveOrder(urls) {
  const seen = new Set();
  const out = [];
  for (const raw of urls) {
    const u = String(raw || "").trim();
    if (!u) continue;
    const key = getVideoIdFromUrl(u) || u;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

const MAX_BULK_INPUT_ROWS = 50;
const MAX_EXPANDED_QUEUE_ADD = (() => {
  const raw = process.env.MAX_EXPANDED_QUEUE_ADD;
  if (raw === undefined || raw === "") return 50000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50000;
  return Math.min(Math.floor(n), 100000);
})();
/** If unset or 0, yt-dlp gets the whole playlist (no --playlist-end). Set MAX_PLAYLIST_ITEMS to cap. */
const MAX_PLAYLIST_ITEMS_PER_INPUT = (() => {
  const raw = process.env.MAX_PLAYLIST_ITEMS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 100000);
})();
const MAX_BULK_QUEUE_DELETE = 100;

async function expandYoutubeInputToWatchUrls(rawInput) {
  const url = String(rawInput || "").trim();
  if (!url) return [];

  let hasListParam = false;
  try {
    const uObj = new URL(url);
    const host = uObj.hostname.toLowerCase();
    const listId = uObj.searchParams.get("list") || "";
    const isMixOrRadio = /^RD/i.test(listId);
    if (
      (host.endsWith(".youtube.com") || host === "youtube.com" || host === "youtu.be") &&
      listId &&
      !isMixOrRadio
    ) {
      hasListParam = true;
    }
  } catch (_e) {
    /* ignore */
  }

  const extractFlat = async () => {
    const dumpOpts = {
      dumpSingleJson: true,
      skipDownload: true,
      flatPlaylist: true,
      noPlaylist: false
    };
    if (MAX_PLAYLIST_ITEMS_PER_INPUT > 0) {
      dumpOpts.playlistEnd = MAX_PLAYLIST_ITEMS_PER_INPUT;
    }
    const json = await runYtDlpDumpJson(url, dumpOpts);
    return extractWatchUrlsFromFlatJson(json);
  };

  try {
    if (ytdl.validateURL(url)) {
      if (hasListParam) {
        const fromPl = await extractFlat();
        if (fromPl.length > 0) return dedupeWatchUrlsPreserveOrder(fromPl.map(canonicalizeYoutubeWatchUrl));
      }
      return dedupeWatchUrlsPreserveOrder([canonicalizeYoutubeWatchUrl(url)]);
    }
    const fromPl = await extractFlat();
    if (fromPl.length > 0) return dedupeWatchUrlsPreserveOrder(fromPl.map(canonicalizeYoutubeWatchUrl));
  } catch (_err) {
    /* fall through */
  }

  if (ytdl.validateURL(url)) {
    return dedupeWatchUrlsPreserveOrder([canonicalizeYoutubeWatchUrl(url)]);
  }
  return [];
}

function toItem(row) {
  const idNum = Number(row.id);
  return {
    id: Number.isFinite(idNum) ? idNum : row.id,
    userId: Number(row.userId || 0),
    guestId: row.guestId || "",
    url: row.url,
    videoId: row.videoId || "",
    title: row.title || "",
    thumbnailUrl: row.thumbnailUrl || "",
    filename: row.filename || "",
    qualityPreference: row.qualityPreference || "best",
    downloadType: row.downloadType || "video",
    subtitleLanguage: row.subtitleLanguage || "all",
    trimStart: row.trimStart || "",
    trimEnd: row.trimEnd || "",
    status: row.status,
    progress: row.progress || 0,
    message: row.message || "",
    downloadUrl: row.downloadUrl || ""
  };
}

async function insertQueueItemIfEligible(url, qualityPreference, downloadType, trimStart, trimEnd) {
  if (url == null || typeof url !== "string" || !url.trim()) {
    return { ok: false, error: "Please provide a valid YouTube URL." };
  }
  const normalizedUrl = canonicalizeYoutubeWatchUrl(url.trim());
  if (!ytdl.validateURL(normalizedUrl)) {
    return { ok: false, error: "Please provide a valid YouTube URL." };
  }
  const normalizedQuality = qualityPreference ? String(qualityPreference) : "best";
  if (normalizedQuality !== "best" && !/^\d+$/.test(normalizedQuality)) {
    return { ok: false, error: "Invalid quality preference." };
  }
  const trim = normalizeTrimRange(trimStart, trimEnd);
  if (!trim.ok) {
    return { ok: false, error: trim.error || "Invalid trim range." };
  }
  const normalizedDownloadType = normalizeDownloadType(downloadType);
  const normalizedSubtitleLanguage = "all";
  const normalizedVideoId = getVideoIdFromUrl(normalizedUrl);
  const normalizedTrimStart = trim.trimStart;
  const normalizedTrimEnd = trim.trimEnd;

  const existingRows = normalizedVideoId
    ? await allDb(
        "SELECT * FROM queue_items WHERE userId = ? AND guestId = ? AND videoId = ? AND downloadType = ? AND qualityPreference = ? AND IFNULL(trimStart,'') = ? AND IFNULL(trimEnd,'') = ? AND status IN ('queued','downloading','merging','paused') ORDER BY id DESC LIMIT 1",
        [
          this.userId,
          this.guestId || "",
          normalizedVideoId,
          normalizedDownloadType,
          normalizedQuality,
          normalizedTrimStart,
          normalizedTrimEnd
        ]
      )
    : await allDb(
        "SELECT * FROM queue_items WHERE userId = ? AND guestId = ? AND url = ? AND downloadType = ? AND qualityPreference = ? AND IFNULL(trimStart,'') = ? AND IFNULL(trimEnd,'') = ? AND status IN ('queued','downloading','merging','paused') ORDER BY id DESC LIMIT 1",
        [
          this.userId,
          this.guestId || "",
          normalizedUrl,
          normalizedDownloadType,
          normalizedQuality,
          normalizedTrimStart,
          normalizedTrimEnd
        ]
      );
  if (existingRows.length > 0 && isNonRemovableStatus(existingRows[0].status)) {
    return {
      ok: false,
      code: "duplicate_active",
      error: "This video is already active in queue.",
      existingItem: toItem(existingRows[0])
    };
  }

  const result = await runDb(
    "INSERT INTO queue_items (userId, guestId, url, videoId, qualityPreference, downloadType, subtitleLanguage, trimStart, trimEnd, status, progress, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 'Waiting in queue...')",
    [
      this.userId,
      this.guestId || "",
      normalizedUrl,
      normalizedVideoId,
      normalizedQuality,
      normalizedDownloadType,
      normalizedSubtitleLanguage,
      normalizedTrimStart,
      normalizedTrimEnd
    ]
  );
  const rows = await allDb("SELECT * FROM queue_items WHERE id = ?", [result.lastID]);
  const item = toItem(rows[0]);
  queue.push(item);
  return { ok: true, item };
}

async function deleteQueueItemRow(id, shouldDeleteFile) {
  const rows = await allDb("SELECT * FROM queue_items WHERE id = ? AND userId = ? AND guestId = ?", [
    id,
    this.userId,
    this.guestId || ""
  ]);
  if (!rows.length) return { ok: false, reason: "not_found" };
  const item = toItem(rows[0]);
  if (item.status === "downloading" || item.status === "merging" || item.status === "trimming") {
    return { ok: false, reason: "active_download" };
  }
  if (shouldDeleteFile && item.filename) {
    const safeName = path.basename(item.filename);
    const filePath = path.join(downloadsDir, safeName);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        return { ok: false, reason: "file_delete_failed", message: err.message };
      }
    }
  }
  await runDb("DELETE FROM queue_items WHERE id = ? AND userId = ? AND guestId = ?", [
    id,
    this.userId,
    this.guestId || ""
  ]);
  return { ok: true };
}

async function pruneCompletedMissingFiles() {
  const rows = await allDb(
    "SELECT id, filename FROM queue_items WHERE status = 'completed' AND filename IS NOT NULL AND filename != ''"
  );
  for (const row of rows) {
    const filePath = path.join(downloadsDir, path.basename(row.filename));
    if (!fs.existsSync(filePath)) {
      await runDb("DELETE FROM queue_items WHERE id = ?", [row.id]);
    }
  }
}

async function loadQueue() {
  await runDb(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      isAdmin INTEGER DEFAULT 0,
      resetToken TEXT,
      resetExpiresAt TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  try {
    await runDb("ALTER TABLE users ADD COLUMN resetToken TEXT");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE users ADD COLUMN resetExpiresAt TEXT");
  } catch (_err) {
    // Column already exists in existing databases.
  }

  await runDb(
    `CREATE TABLE IF NOT EXISTS guest_usage (
      guestId TEXT PRIMARY KEY,
      completedDownloads INTEGER DEFAULT 0,
      totalJobs INTEGER DEFAULT 0,
      updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );

  await runDb(
    `CREATE TABLE IF NOT EXISTS queue_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER DEFAULT 0,
      guestId TEXT DEFAULT '',
      url TEXT NOT NULL,
      videoId TEXT DEFAULT '',
      title TEXT DEFAULT '',
      thumbnailUrl TEXT DEFAULT '',
      filename TEXT DEFAULT '',
      qualityPreference TEXT DEFAULT 'best',
      downloadType TEXT DEFAULT 'video',
      subtitleLanguage TEXT DEFAULT 'all',
      trimStart TEXT DEFAULT '',
      trimEnd TEXT DEFAULT '',
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      message TEXT DEFAULT '',
      downloadUrl TEXT DEFAULT '',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN userId INTEGER DEFAULT 0");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN guestId TEXT DEFAULT ''");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN qualityPreference TEXT DEFAULT 'best'");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN downloadType TEXT DEFAULT 'video'");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN subtitleLanguage TEXT DEFAULT 'all'");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN videoId TEXT DEFAULT ''");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN thumbnailUrl TEXT DEFAULT ''");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN trimStart TEXT DEFAULT ''");
  } catch (_err) {
    // Column already exists in existing databases.
  }
  try {
    await runDb("ALTER TABLE queue_items ADD COLUMN trimEnd TEXT DEFAULT ''");
  } catch (_err) {
    // Column already exists in existing databases.
  }

  await runDb("UPDATE queue_items SET status = 'queued', progress = 0, message = 'Resuming after restart...' WHERE status IN ('downloading', 'merging', 'trimming')");
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id DESC");
  queue = rows.map(toItem);

  const normalizedAdminUsername = DEFAULT_ADMIN_USERNAME.trim().toLowerCase();
  if (normalizedAdminUsername) {
    const adminExisting = await allDb("SELECT id FROM users WHERE username = ? LIMIT 1", [normalizedAdminUsername]);
    const passwordHash = bcrypt.hashSync(String(DEFAULT_ADMIN_PASSWORD || "Test@162$$"), 10);
    if (!adminExisting.length) {
      await runDb("INSERT INTO users (username, passwordHash, isAdmin) VALUES (?, ?, 1)", [
        normalizedAdminUsername,
        passwordHash
      ]);
    } else {
      await runDb("UPDATE users SET isAdmin = 1, passwordHash = ? WHERE username = ?", [
        passwordHash,
        normalizedAdminUsername
      ]);
    }
  }
}

async function persistItem(item) {
  await runDb(
    `UPDATE queue_items
     SET videoId = ?, title = ?, thumbnailUrl = ?, filename = ?, qualityPreference = ?, downloadType = ?, subtitleLanguage = ?, trimStart = ?, trimEnd = ?, status = ?, progress = ?, message = ?, downloadUrl = ?
     WHERE id = ?`,
    [
      item.videoId || "",
      item.title,
      item.thumbnailUrl || "",
      item.filename,
      item.qualityPreference || "best",
      item.downloadType || "video",
      item.subtitleLanguage || "all",
      item.trimStart || "",
      item.trimEnd || "",
      item.status,
      item.progress,
      item.message,
      item.downloadUrl,
      item.id
    ]
  );
}

async function refreshQueueFromDb() {
  await pruneCompletedMissingFiles();
  const rows = await allDb("SELECT * FROM queue_items ORDER BY id DESC");
  queue = rows.map(toItem);
}

function getNextQueueItems(limit) {
  const activeIds = new Set(Array.from(activeTasks.keys()));
  return queue.filter((item) => item.status === "queued" && !activeIds.has(item.id)).slice(0, limit);
}

function shouldUseYtDlpFallback(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("playable formats") ||
    message.includes("status code: 403") ||
    message.includes("video formats unavailable") ||
    message.includes("no downloadable format")
  );
}

function parseProgressPercent(chunkText) {
  const match = chunkText.match(/(\d{1,3}(?:\.\d+)?)%/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function updateProgressInRange(item, percent, rangeStart, rangeEnd) {
  const mapped = Math.round(rangeStart + (percent / 100) * (rangeEnd - rangeStart));
  if (mapped > item.progress) {
    item.progress = mapped;
    persistItem(item).catch(() => {});
  }
}

async function runYtDlpWithProgress(item, task, ytdlpOptions, progressConfig) {
  const { message, rangeStart, rangeEnd } = progressConfig;
  item.message = message;
  item.progress = Math.max(item.progress, rangeStart);
  await persistItem(item);

  await spawnYtDlpProcess(item.url, ytdlpOptions, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    task,
    onChunk: (chunkText) => {
      const percent = parseProgressPercent(String(chunkText || ""));
      if (percent === null) return;
      updateProgressInRange(item, percent, rangeStart, rangeEnd);
    }
  });
  item.progress = Math.max(item.progress, rangeEnd);
}

async function downloadWithYtDlpFallback(item, task) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg is required for yt-dlp fallback.");
  }

  const safeVideoId = sanitizeFileName(item.videoId || getVideoIdFromUrl(item.url) || "unknown_video_id");
  const qualitySuffix = getQualitySuffix(item.qualityPreference);
  const trimSuffix = getTrimFilenameSuffix(item.trimStart, item.trimEnd);
  const outputBase = `${safeVideoId}_${qualitySuffix}${trimSuffix}`;
  const outputTemplate = path.join(downloadsDir, `${outputBase}.%(ext)s`);
  item.status = "downloading";

  await runYtDlpWithProgress(
    item,
    task,
    withTrimYtDlpOptions(
      {
        noPlaylist: true,
        noWarnings: true,
        preferFreeFormats: true,
        // Use single playable stream to avoid broken merge edge-cases.
        format: "best[ext=mp4]/best",
        output: outputTemplate,
        ffmpegLocation: ffmpegPath
      },
      item
    ),
    {
      message: item.trimStart || item.trimEnd ? "Retrying trimmed clip (yt-dlp fallback)..." : "Retrying with yt-dlp fallback...",
      rangeStart: 5,
      rangeEnd: 98
    }
  );

  const preferredCandidates = [`${outputBase}.mp4`, `${outputBase}.webm`, `${outputBase}.mkv`];
  const existingPreferred = preferredCandidates.find((name) => {
    const candidatePath = path.join(downloadsDir, name);
    return fs.existsSync(candidatePath);
  });

  const fallbackCandidate =
    fs
      .readdirSync(downloadsDir)
      .find((name) => {
        if (!name.startsWith(`${outputBase}.`)) return false;
        const ext = path.extname(name).toLowerCase();
        return [".mp4", ".webm", ".mkv"].includes(ext);
      }) || "";

  const finalFileName = existingPreferred || fallbackCandidate;
  if (!finalFileName) {
    throw new Error("Fallback download finished but output file was not found.");
  }

  item.filename = finalFileName;
  item.title = item.title || item.filename.replace(path.extname(item.filename), "");
  item.downloadUrl = `/downloads/${encodeURIComponent(item.filename)}`;
  item.progress = 100;
  item.status = "completed";
  item.message = "Download completed (yt-dlp fallback)";
  await persistItem(item);
}

async function downloadVideoWithYtDlp(item, task, safeVideoId, preferredHeight) {
  const qualitySuffix = getQualitySuffix(item.qualityPreference);
  const trimSuffix = getTrimFilenameSuffix(item.trimStart, item.trimEnd);
  const outputBase = `${safeVideoId}_${qualitySuffix}${trimSuffix}`;
  const outputTemplate = path.join(downloadsDir, `${outputBase}.%(ext)s`);
  const formatSelector = preferredHeight
    ? `bestvideo[height<=${preferredHeight}]+bestaudio/best[height<=${preferredHeight}]/best`
    : "bestvideo+bestaudio/best";

  await runYtDlpWithProgress(
    item,
    task,
    withTrimYtDlpOptions(
      {
        noPlaylist: true,
        noWarnings: true,
        format: formatSelector,
        mergeOutputFormat: "mp4",
        output: outputTemplate,
        ffmpegLocation: ffmpegPath
      },
      item
    ),
    {
      message: item.trimStart || item.trimEnd ? "Downloading trimmed video..." : "Downloading video...",
      rangeStart: 5,
      rangeEnd: 98
    }
  );

  const candidates = [`${outputBase}.mp4`, `${outputBase}.webm`, `${outputBase}.mkv`];
  const fileName = candidates.find((name) => fs.existsSync(path.join(downloadsDir, name)));
  if (!fileName) {
    throw new Error("Video output file was not found.");
  }

  item.filename = fileName;
  item.progress = 100;
  item.status = "completed";
  item.message = "Video download completed";
  item.downloadUrl = `/downloads/${encodeURIComponent(item.filename)}`;
  await persistItem(item);
}

async function processQueueItem(item) {
  const task = {
    itemId: item.id,
    ytDlpProcess: null,
    canceled: false,
    paused: false
  };
  activeTasks.set(item.id, task);

  try {
    item.status = "downloading";
    item.message = "Fetching video info...";
    item.progress = 0;
    if (getVideoIdFromUrl(item.url)) {
      item.url = canonicalizeYoutubeWatchUrl(item.url);
    }
    await persistItem(item);

    const metadata = await getVideoMetadataWithYtDlp(item.url);
    const preferredHeight = parseQualityPreference(item.qualityPreference);
    const downloadType = normalizeDownloadType(item.downloadType);
    item.videoId = metadata?.id || item.videoId || getVideoIdFromUrl(item.url) || "";

    const safeVideoId = sanitizeFileName(item.videoId || "unknown_video_id");
    item.title = metadata?.title || item.title;
    const thumbnails = Array.isArray(metadata?.thumbnails) ? metadata.thumbnails : [];
    item.thumbnailUrl = thumbnails.length > 0 ? thumbnails[thumbnails.length - 1].url || "" : "";
    item.message = "Preparing download streams...";
    item.progress = 1;
    await persistItem(item);

    if (downloadType === "mp3") {
      const trimSuffix = getTrimFilenameSuffix(item.trimStart, item.trimEnd);
      const mp3OutputPath = path.join(downloadsDir, `${safeVideoId}${trimSuffix}.mp3`);
      await runYtDlpWithProgress(
        item,
        task,
        withTrimYtDlpOptions(
          {
            noPlaylist: true,
            noWarnings: true,
            extractAudio: true,
            audioFormat: "mp3",
            audioQuality: "0",
            output: mp3OutputPath,
            ffmpegLocation: ffmpegPath
          },
          item
        ),
        {
          message: item.trimStart || item.trimEnd ? "Downloading trimmed audio (MP3)..." : "Downloading audio (MP3)...",
          rangeStart: 5,
          rangeEnd: 98
        }
      );

      if (!fs.existsSync(mp3OutputPath)) throw new Error("MP3 output file not found.");
      item.filename = path.basename(mp3OutputPath);
      item.progress = 100;
      item.status = "completed";
      item.message = "MP3 download completed";
      item.downloadUrl = `/downloads/${encodeURIComponent(item.filename)}`;
      await persistItem(item);
      return;
    }

    await downloadVideoWithYtDlp(item, task, safeVideoId, preferredHeight);
  } catch (err) {
    if (item.status !== "paused") {
      if (shouldUseYtDlpFallback(err) && !task.canceled) {
        try {
          await downloadWithYtDlpFallback(item, task);
        } catch (fallbackErr) {
          item.status = "failed";
          item.message = fallbackErr.message || err.message || "Download failed";
          await persistItem(item);
        }
      } else {
        item.status = "failed";
        item.message = err.message || "Download failed";
        await persistItem(item);
      }
    }
  } finally {
    activeTasks.delete(item.id);
    await refreshQueueFromDb();
    if (item.userId === 0 && item.guestId) {
      await recomputeGuestCompletedFromQueue(item.guestId);
    }
    scheduleQueueProcessing();
  }
}

function scheduleQueueProcessing() {
  const availableSlots = MAX_CONCURRENT_DOWNLOADS - activeTasks.size;
  if (availableSlots <= 0) return;
  const nextItems = getNextQueueItems(availableSlots);
  for (const item of nextItems) {
    processQueueItem(item);
  }
}

app.post("/api/queue", async (req, res) => {
  try {
    const { url, qualityPreference, downloadType, trimStart, trimEnd } = req.body || {};
    const trimmed = typeof url === "string" ? url.trim() : "";
    if (!trimmed) {
      return res.status(400).json({ error: "Please provide a valid YouTube URL or playlist." });
    }

    const expanded = await expandYoutubeInputToWatchUrls(trimmed);
    if (!expanded.length) {
      return res.status(400).json({ error: "Please provide a valid YouTube URL or playlist." });
    }
    if (expanded.length > MAX_EXPANDED_QUEUE_ADD) {
      return res.status(400).json({
        error: `Playlist too large (${expanded.length} videos, max ${MAX_EXPANDED_QUEUE_ADD}). Split into batches.`
      });
    }

    const ctx = { userId: req.authUserId || 0, guestId: req.guestId || "" };
    // Trim only for a single resolved video; playlist expansion stays full-length.
    const applyTrim = expanded.length === 1;
    const useTrimStart = applyTrim ? trimStart : "";
    const useTrimEnd = applyTrim ? trimEnd : "";

    if (expanded.length === 1) {
      const r = await insertQueueItemIfEligible.call(
        ctx,
        expanded[0],
        qualityPreference,
        downloadType,
        useTrimStart,
        useTrimEnd
      );
      if (!r.ok) {
        if (r.code === "duplicate_active") {
          return res.status(409).json({
            error: r.error || "This video is already active in queue.",
            existingItem: r.existingItem
          });
        }
        return res.status(400).json({ error: r.error || "Could not add video." });
      }
      if (!req.authUserId && req.guestId) {
        await bumpGuestTotalJobs(req.guestId, 1);
      }
      scheduleQueueProcessing();
      return res.status(201).json(r.item);
    }

    const created = [];
    const errors = [];
    for (const u of expanded) {
      const r = await insertQueueItemIfEligible.call(ctx, u, qualityPreference, downloadType, "", "");
      if (r.ok) {
        created.push(r.item);
      } else {
        errors.push({
          url: u,
          error: r.error || "Could not add",
          code: r.code || "invalid",
          existingItem: r.existingItem
        });
      }
    }

    if (!req.authUserId && req.guestId && created.length) {
      await bumpGuestTotalJobs(req.guestId, created.length);
    }
    scheduleQueueProcessing();

    return res.status(201).json({
      queued: created,
      errors,
      expandedCount: expanded.length,
      playlistExpanded: true
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not add video." });
  }
});

app.post("/api/queue/bulk", async (req, res) => {
  try {
    const { items: rawItems } = req.body || {};
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return res.status(400).json({ error: "Provide a non-empty items array." });
    }
    if (rawItems.length > MAX_BULK_INPUT_ROWS) {
      return res.status(400).json({ error: `Too many rows (max ${MAX_BULK_INPUT_ROWS} per request).` });
    }

    const ctx = { userId: req.authUserId || 0, guestId: req.guestId || "" };
    const flattened = [];
    const errors = [];

    for (let i = 0; i < rawItems.length; i++) {
      const entry = rawItems[i] || {};
      const lineUrl = typeof entry.url === "string" ? entry.url.trim() : "";
      if (!lineUrl) {
        errors.push({ index: i, url: "", error: "Empty URL.", code: "invalid" });
        continue;
      }
      const urls = await expandYoutubeInputToWatchUrls(lineUrl);
      if (!urls.length) {
        errors.push({
          index: i,
          url: lineUrl,
          error: "Could not resolve URL or playlist.",
          code: "invalid"
        });
        continue;
      }
      // Bulk/playlist lines: full length only (no trim in this pass).
      for (const u of urls) {
        flattened.push({
          url: u,
          qualityPreference: entry.qualityPreference,
          downloadType: entry.downloadType,
          trimStart: "",
          trimEnd: "",
          sourceIndex: i
        });
      }
    }

    if (flattened.length > MAX_EXPANDED_QUEUE_ADD) {
      return res.status(400).json({
        error: `Too many videos after expanding playlists (max ${MAX_EXPANDED_QUEUE_ADD}). Fewer playlists per batch or split your list.`
      });
    }

    const created = [];
    for (let j = 0; j < flattened.length; j++) {
      const row = flattened[j];
      const r = await insertQueueItemIfEligible.call(
        ctx,
        row.url,
        row.qualityPreference,
        row.downloadType,
        row.trimStart,
        row.trimEnd
      );
      if (r.ok) {
        created.push(r.item);
      } else {
        errors.push({
          index: row.sourceIndex,
          url: row.url,
          error: r.error || "Could not add",
          code: r.code || "invalid",
          existingItem: r.existingItem
        });
      }
    }

    if (!req.authUserId && req.guestId && created.length) {
      await bumpGuestTotalJobs(req.guestId, created.length);
    }
    scheduleQueueProcessing();
    return res.json({
      created,
      errors,
      expandedTotal: flattened.length,
      inputRows: rawItems.length
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Bulk add failed." });
  }
});

app.post("/api/formats", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string" || !String(url).trim()) {
      return res.status(400).json({ error: "Please provide a valid YouTube URL or playlist." });
    }

    const trimmed = url.trim();
    let targetUrl = trimmed;
    let playlistVideoCount = 1;

    const expanded = await expandYoutubeInputToWatchUrls(trimmed);
    if (expanded.length > 0) {
      playlistVideoCount = expanded.length;
      targetUrl = expanded[0];
    } else if (ytdl.validateURL(trimmed)) {
      targetUrl = trimmed;
      playlistVideoCount = 1;
    } else {
      return res.status(400).json({ error: "Please provide a valid YouTube URL or playlist." });
    }

    const metadata = await getVideoMetadataWithYtDlp(targetUrl);
    const durationRaw = Number(metadata?.duration);
    const duration = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null;
    return res.json({
      title: metadata?.title || "",
      qualities: buildQualityOptionsFromMetadata(metadata),
      ...(duration != null ? { duration } : {}),
      ...(playlistVideoCount > 1 ? { playlistVideoCount } : {})
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Could not fetch quality options." });
  }
});

app.get("/api/queue", async (_req, res) => {
  await refreshQueueFromDb();
  const viewerId = _req.authUserId || 0;
  const guestId = _req.guestId || "";
  const visible = _req.authIsAdmin
    ? queue
    : queue.filter((q) =>
        viewerId
          ? Number(q.userId || 0) === Number(viewerId)
          : Number(q.userId || 0) === 0 && String(q.guestId || "") === String(guestId)
      );
  res.json(visible);
});

app.post("/api/queue/:id/action", async (req, res) => {
  const id = Number(req.params.id);
  const { action } = req.body || {};
  const viewerId = req.authUserId || 0;
  const guestId = req.guestId || "";
  const item = queue.find((q) =>
    q.id === id
      ? viewerId
        ? Number(q.userId || 0) === Number(viewerId)
        : Number(q.userId || 0) === 0 && String(q.guestId || "") === String(guestId)
      : false
  );
  if (!item) return res.status(404).json({ error: "Queue item not found." });

  if (!["pause", "resume", "cancel", "retry"].includes(action)) {
    return res.status(400).json({ error: "Invalid action." });
  }

  if (action === "pause") {
    return res.status(400).json({ error: "Pause is not supported in current download engine." });
  }

  if (action === "resume") {
    return res.status(400).json({ error: "Resume is not supported in current download engine." });
  }

  if (action === "cancel") {
    const task = activeTasks.get(id);
    if (task) {
      task.canceled = true;
      if (task.ytDlpProcess) task.ytDlpProcess.kill("SIGTERM");
    }
    item.status = "cancelled";
    item.message = "Cancelled by user";
    await persistItem(item);
    return res.json(item);
  }

  if (action === "retry") {
    if (!["failed", "cancelled"].includes(item.status)) {
      return res.status(400).json({ error: "Only failed or cancelled items can be retried." });
    }
    if (activeTasks.has(id) || trimmingJobs.has(id)) {
      return res.status(409).json({ error: "This item is already being processed." });
    }
    item.status = "queued";
    item.progress = 0;
    item.message = "Retry queued";
    item.filename = "";
    item.downloadUrl = "";
    await persistItem(item);
    scheduleQueueProcessing();
    return res.json(item);
  }

  return res.status(400).json({ error: "Unsupported action." });
});

app.post("/api/queue/:id/trim", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid queue item id." });
  }

  await refreshQueueFromDb();
  const item = findOwnedQueueItem(req, id);
  if (!item) {
    return res.status(404).json({ error: "Queue item not found." });
  }
  if (item.status !== "completed") {
    return res.status(400).json({ error: "Only completed downloads can be trimmed." });
  }
  if (trimmingJobs.has(id) || activeTasks.has(id)) {
    return res.status(409).json({ error: "This item is already being processed." });
  }
  if (!item.filename) {
    return res.status(400).json({ error: "No downloaded file to trim." });
  }

  const { start, end } = req.body || {};
  const trim = normalizeTrimRange(start, end == null || String(end).trim() === "" ? undefined : end);
  if (!trim.ok) {
    return res.status(400).json({ error: trim.error || "Invalid trim range." });
  }
  if (!trim.trimStart && !trim.trimEnd) {
    return res.status(400).json({ error: "Provide start and end times to trim." });
  }
  if (!trim.trimEnd) {
    return res.status(400).json({ error: "Trim end is required for post-download trim." });
  }

  const startSec = parseTimeToSeconds(trim.trimStart || "0:00");
  const endSec = parseTimeToSeconds(trim.trimEnd);
  if (startSec === null || endSec === null || endSec <= startSec) {
    return res.status(400).json({ error: "Trim end must be after trim start." });
  }
  if (endSec - startSec < 0.5) {
    return res.status(400).json({ error: "Trim range must be at least 0.5 seconds." });
  }

  const safeName = path.basename(item.filename);
  const inputPath = path.join(downloadsDir, safeName);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: "Downloaded file not found on disk." });
  }

  const duration = await probeMediaDurationSeconds(inputPath);
  if (duration != null && endSec > duration + 0.25) {
    return res.status(400).json({
      error: `Trim end exceeds media duration (~${formatSecondsAsHms(duration)}).`
    });
  }

  const isMp3 = normalizeDownloadType(item.downloadType) === "mp3";
  const ext = path.extname(safeName) || (isMp3 ? ".mp3" : ".mp4");
  const baseNoExt = path.basename(safeName, ext);
  // Strip previous _t... suffix if re-trimming
  const baseClean = baseNoExt.replace(/_t\d+-(?:\d+|end)$/i, "");
  const trimSuffix = getTrimFilenameSuffix(trim.trimStart || "0:00", trim.trimEnd);
  const outName = sanitizeFileName(`${baseClean}${trimSuffix}`) + ext;
  const outputPath = path.join(downloadsDir, outName);

  if (path.resolve(outputPath) === path.resolve(inputPath)) {
    return res.status(400).json({ error: "Trim output would overwrite input unexpectedly." });
  }

  trimmingJobs.add(id);
  item.status = "trimming";
  item.message = "Trimming with ffmpeg...";
  item.progress = Math.max(item.progress || 0, 5);
  await persistItem(item);

  try {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    await ffmpegCutFile(inputPath, outputPath, startSec, endSec, isMp3);

    const oldPath = inputPath;
    item.filename = outName;
    item.downloadUrl = `/downloads/${encodeURIComponent(outName)}`;
    item.trimStart = trim.trimStart || formatSecondsAsHms(0);
    item.trimEnd = trim.trimEnd;
    item.status = "completed";
    item.progress = 100;
    item.message = `Trim applied (${item.trimStart} → ${item.trimEnd})`;
    await persistItem(item);

    if (path.resolve(oldPath) !== path.resolve(outputPath) && fs.existsSync(oldPath)) {
      try {
        fs.unlinkSync(oldPath);
      } catch (_err) {
        /* keep new file even if old delete fails */
      }
    }

    await refreshQueueFromDb();
    const updated = findOwnedQueueItem(req, id) || item;
    return res.json(updated);
  } catch (err) {
    item.status = "completed";
    item.message = err.message || "Trim failed";
    item.progress = 100;
    await persistItem(item);
    return res.status(500).json({ error: err.message || "Trim failed." });
  } finally {
    trimmingJobs.delete(id);
  }
});

app.post("/api/queue/bulk-delete", async (req, res) => {
  try {
    const { ids, deleteFile } = req.body || {};
    const shouldDeleteFile = Boolean(deleteFile);
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Provide a non-empty ids array." });
    }
    if (ids.length > MAX_BULK_QUEUE_DELETE) {
      return res.status(400).json({ error: `Too many ids (max ${MAX_BULK_QUEUE_DELETE}).` });
    }
    const uniqueIds = [
      ...new Set(
        ids
          .map((raw) => {
            const n = parseInt(String(raw === null || raw === undefined ? "" : raw), 10);
            return Number.isFinite(n) && n > 0 ? n : null;
          })
          .filter((n) => n != null)
      )
    ];
    const removed = [];
    const skipped = [];
    for (const id of uniqueIds) {
      const result = await deleteQueueItemRow.call(
        { userId: req.authUserId || 0, guestId: req.guestId || "" },
        id,
        shouldDeleteFile
      );
      if (result.ok) {
        removed.push(id);
      } else {
        skipped.push({
          id,
          reason: result.reason,
          message: result.message
        });
      }
    }
    await refreshQueueFromDb();
    return res.json({ removed, skipped });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Bulk delete failed." });
  }
});

app.delete("/api/queue/:id", async (req, res) => {
  const id = Number(req.params.id);
  const shouldDeleteFile = String(req.query.deleteFile || "false").toLowerCase() === "true";
  const result = await deleteQueueItemRow.call(
    { userId: req.authUserId || 0, guestId: req.guestId || "" },
    id,
    shouldDeleteFile
  );
  if (!result.ok) {
    if (result.reason === "not_found") {
      return res.status(404).json({ error: "Queue item not found." });
    }
    if (result.reason === "active_download") {
      return res.status(400).json({ error: "Use cancel for active download." });
    }
    if (result.reason === "file_delete_failed") {
      return res.status(500).json({ error: result.message || "Failed to delete associated file." });
    }
    return res.status(400).json({ error: "Could not remove item." });
  }
  await refreshQueueFromDb();
  return res.status(204).send();
});

app.get("/downloads/:filename", async (req, res) => {
  try {
    const rawName = String(req.params.filename || "");
    const fileName = path.basename(rawName);
    const filePath = path.join(downloadsDir, fileName);
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");

    const rows = await allDb(
      "SELECT id, userId, guestId FROM queue_items WHERE filename = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
      [fileName]
    );
    if (!rows.length) return res.status(404).send("Not found");
    const ownerId = Number(rows[0].userId || 0);
    const ownerGuestId = String(rows[0].guestId || "");
    const viewerId = Number(req.authUserId || 0);
    const viewerGuestId = String(req.guestId || "");
    if (!req.authIsAdmin && !(ownerId && ownerId === viewerId) && !(ownerId === 0 && ownerGuestId && ownerGuestId === viewerGuestId)) {
      return res.status(403).send("Forbidden");
    }
    return res.sendFile(filePath);
  } catch (_err) {
    return res.status(500).send("Server error");
  }
});

app.get("/api/analytics/users", requireAdmin, async (_req, res) => {
  try {
    const rows = await allDb(
      `SELECT u.id as userId, u.username as username,
              SUM(CASE WHEN q.status = 'completed' THEN 1 ELSE 0 END) as completedDownloads,
              COUNT(q.id) as totalJobs
       FROM users u
       LEFT JOIN queue_items q ON q.userId = u.id
       GROUP BY u.id, u.username
       ORDER BY completedDownloads DESC, totalJobs DESC, u.username ASC`
    );
    return res.json(
      rows.map((r) => ({
        userId: r.userId,
        username: r.username,
        completedDownloads: Number(r.completedDownloads || 0),
        totalJobs: Number(r.totalJobs || 0)
      }))
    );
  } catch (err) {
    return res.status(500).json({ error: err.message || "Analytics failed." });
  }
});

app.get("/api/analytics/me", requireAuth, async (req, res) => {
  try {
    const uid = Number(req.authUserId || 0);
    const gid = String(req.guestId || "");
    if (uid > 0) {
      const rows = await allDb(
        `SELECT
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completedDownloads,
          COUNT(id) as totalJobs
         FROM queue_items
         WHERE userId = ?`,
        [uid]
      );
      const r = rows[0] || {};
      return res.json({
        viewerType: "user",
        username: req.authUser,
        isAdmin: Boolean(req.authIsAdmin),
        completedDownloads: Number(r.completedDownloads || 0),
        totalJobs: Number(r.totalJobs || 0)
      });
    }
    const usage = await getGuestUsage(gid);
    return res.json({
      viewerType: "guest",
      username: "Guest",
      completedDownloads: Number(usage.completedDownloads || 0),
      totalJobs: Number(usage.totalJobs || 0),
      freeLimit: GUEST_FREE_COMPLETED_LIMIT
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Analytics failed." });
  }
});

app.get("/api/analytics/activity", requireAuth, async (req, res) => {
  try {
    let rows = [];
    if (req.authIsAdmin) {
      rows = await allDb(
        `SELECT
           q.id,
           q.userId,
           q.guestId,
           COALESCE(u.username, 'guest') as owner,
           q.url,
           q.videoId,
           q.downloadType,
           q.qualityPreference,
           q.status,
           q.progress,
           q.message,
           q.createdAt
         FROM queue_items q
         LEFT JOIN users u ON u.id = q.userId
         ORDER BY q.id DESC
         LIMIT 500`
      );
    } else if (Number(req.authUserId || 0) > 0) {
      rows = await allDb(
        `SELECT
           q.id,
           q.userId,
           q.guestId,
           ? as owner,
           q.url,
           q.videoId,
           q.downloadType,
           q.qualityPreference,
           q.status,
           q.progress,
           q.message,
           q.createdAt
         FROM queue_items q
         WHERE q.userId = ?
         ORDER BY q.id DESC
         LIMIT 300`,
        [req.authUser || "user", Number(req.authUserId || 0)]
      );
    } else {
      rows = await allDb(
        `SELECT
           q.id,
           q.userId,
           q.guestId,
           'guest' as owner,
           q.url,
           q.videoId,
           q.downloadType,
           q.qualityPreference,
           q.status,
           q.progress,
           q.message,
           q.createdAt
         FROM queue_items q
         WHERE q.userId = 0 AND q.guestId = ?
         ORDER BY q.id DESC
         LIMIT 300`,
        [String(req.guestId || "")]
      );
    }
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: err.message || "Activity analytics failed." });
  }
});

app.get("/api/users", requireAdmin, async (_req, res) => {
  const rows = await allDb("SELECT id, username, isAdmin, createdAt FROM users ORDER BY id DESC");
  res.json(
    rows.map((u) => ({
      id: u.id,
      username: u.username,
      isAdmin: Boolean(u.isAdmin),
      createdAt: u.createdAt
    }))
  );
});
app.use(express.static(path.join(__dirname, "public")));

function listenOnPort(port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    const onError = (err) => {
      server.removeListener("listening", onListening);
      server.close(() => reject(err));
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

/**
 * Start HTTP server. Safe to call once from Electron or CLI.
 * @param {{ port?: number, host?: string, dataDir?: string }} [options]
 * @returns {Promise<{ port: number, host: string, close: () => Promise<void> }>}
 */
async function startServer(options = {}) {
  if (serverBootstrapped && httpServer && listeningPort != null) {
    return {
      port: listeningPort,
      host: options.host || "127.0.0.1",
      close: closeServer
    };
  }

  ensureDataPaths(options.dataDir || process.env.YD_DATA_DIR || null);
  try {
    await ytEngine.prepare(dataRoot);
  } catch (err) {
    console.warn("yt-dlp tools prepare warning:", err.message || err);
  }
  await loadQueue();

  const preferred = Number(options.port || process.env.PORT || DEFAULT_PORT);
  const host = options.host || "127.0.0.1";
  let lastError = null;

  for (let port = preferred; port < preferred + 40; port++) {
    try {
      httpServer = await listenOnPort(port, host);
      listeningPort = port;
      serverBootstrapped = true;
      scheduleQueueProcessing();
      console.log(`YouTube downloader running at http://${host}:${port}`);
      return {
        port,
        host,
        close: closeServer
      };
    } catch (err) {
      lastError = err;
      if (err && err.code === "EADDRINUSE") {
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`Could not bind a port starting at ${preferred}`);
}

function closeServer() {
  return new Promise((resolve) => {
    if (!httpServer) {
      resolve();
      return;
    }
    const server = httpServer;
    httpServer = null;
    listeningPort = null;
    serverBootstrapped = false;
    server.close(() => resolve());
  });
}

module.exports = {
  app,
  startServer,
  closeServer
};

if (require.main === module) {
  startServer({ host: "0.0.0.0", port: DEFAULT_PORT })
    .catch((err) => {
      console.error("Failed to start app:", err);
      process.exit(1);
    });
}