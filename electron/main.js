const path = require("path");
const fs = require("fs");
const { app, BrowserWindow, shell } = require("electron");

// Writable downloads + SQLite outside Program Files / asar
process.env.YD_DATA_DIR = process.env.YD_DATA_DIR || app.getPath("userData");

// Native binaries cannot be executed from inside app.asar — point to asar.unpacked.
if (app.isPackaged) {
  const unpackedRoot = app.getAppPath().replace(/app\.asar(?!\.unpacked)/, "app.asar.unpacked");
  const ytDlpDir = path.join(unpackedRoot, "node_modules", "yt-dlp-exec", "bin");
  const ffmpegBin = path.join(
    unpackedRoot,
    "node_modules",
    "ffmpeg-static",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );
  if (fs.existsSync(ytDlpDir)) {
    process.env.YOUTUBE_DL_DIR = ytDlpDir;
  }
  if (fs.existsSync(ffmpegBin)) {
    process.env.FFMPEG_BIN = ffmpegBin;
  }
}

const { startServer, closeServer } = require("../server");

let mainWindow = null;
let serverInfo = null;
let isQuitting = false;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  function createWindow(port) {
    const iconPath = path.join(__dirname, "..", "build", "icon.ico");
    const windowOpts = {
      width: 1280,
      height: 840,
      minWidth: 900,
      minHeight: 600,
      title: "YouTube Downloader Pro",
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    };
    if (fs.existsSync(iconPath)) {
      windowOpts.icon = iconPath;
    }
    mainWindow = new BrowserWindow(windowOpts);

    mainWindow.once("ready-to-show", () => {
      mainWindow.show();
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.loadURL(`http://127.0.0.1:${port}`);

    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  }

  async function boot() {
    // Use a dedicated port so desktop does not steal localhost:3000 from `npm start` web mode.
    serverInfo = await startServer({
      host: "127.0.0.1",
      port: Number(process.env.PORT || 3927),
      dataDir: process.env.YD_DATA_DIR
    });
    createWindow(serverInfo.port);
  }

  app.whenReady().then(() => {
    boot().catch((err) => {
      console.error("Failed to start desktop app:", err);
      app.quit();
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0 && serverInfo) {
        createWindow(serverInfo.port);
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", (event) => {
    if (isQuitting || !serverInfo) return;
    event.preventDefault();
    isQuitting = true;
    closeServer()
      .catch(() => {})
      .finally(() => {
        serverInfo = null;
        app.exit(0);
      });
  });
}
