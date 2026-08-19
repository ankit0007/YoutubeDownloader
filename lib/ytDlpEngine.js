const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawn, execFileSync } = require("child_process");

function resolveAsarUnpackedPath(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
  if (filePath.includes(`${path.sep}app.asar.unpacked${path.sep}`)) return filePath;
  if (filePath.includes(`${path.sep}app.asar${path.sep}`)) {
    return filePath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  }
  if (filePath.endsWith(`${path.sep}app.asar`)) {
    return `${filePath}.unpacked`;
  }
  return filePath;
}

function fileExists(p) {
  try {
    return Boolean(p && fs.existsSync(p));
  } catch (_err) {
    return false;
  }
}

function findNodeExecutable() {
  const candidates = [];
  const fromEnv = String(process.env.YD_NODE_PATH || "").trim();
  if (fromEnv) candidates.push(fromEnv);

  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(cmd, ["node"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true
    });
    for (const line of String(out).split(/\r?\n/)) {
      if (line.trim()) candidates.push(line.trim());
    }
  } catch (_err) {
    // ignore
  }

  if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe")
    );
  }

  if (!process.versions.electron && process.execPath) {
    candidates.push(process.execPath);
  }

  for (const candidate of candidates) {
    if (!fileExists(candidate)) continue;
    const base = path.basename(candidate).toLowerCase();
    if (base !== "node.exe" && base !== "node") continue;
    try {
      const ver = execFileSync(candidate, ["-v"], {
        encoding: "utf8",
        timeout: 8000,
        windowsHide: true
      }).trim();
      const major = Number(String(ver).replace(/^v/, "").split(".")[0]);
      if (Number.isFinite(major) && major >= 20) return candidate;
    } catch (_err) {
      // try next
    }
  }
  return "";
}

function httpsGetBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("Too many redirects"));
    https
      .get(
        url,
        {
          headers: { "User-Agent": "YouTubeDownloaderPro" }
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return resolve(httpsGetBuffer(res.headers.location, redirects + 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`Download failed (${res.statusCode})`));
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }
      )
      .on("error", reject);
  });
}

function runQuiet(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { windowsHide: true });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_err) {
        // ignore
      }
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function ensureDeno(toolsDir) {
  const denoName = process.platform === "win32" ? "deno.exe" : "deno";
  const denoPath = path.join(toolsDir, denoName);
  if (fileExists(denoPath)) return denoPath;
  if (process.platform !== "win32") return "";

  const zipPath = path.join(toolsDir, "deno.zip");
  try {
    const buf = await httpsGetBuffer(
      "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"
    );
    fs.writeFileSync(zipPath, buf);
    const ok = await runQuiet("tar", ["-xf", zipPath, "-C", toolsDir], 120000);
    try {
      fs.unlinkSync(zipPath);
    } catch (_err) {
      // ignore
    }
    if (ok && fileExists(denoPath)) return denoPath;
  } catch (_err) {
    // deno is optional if node is present
  }
  return fileExists(denoPath) ? denoPath : "";
}

function createEngine({ bundledYtDlpPath, ffmpegPath }) {
  let ytDlpPath = resolveAsarUnpackedPath(bundledYtDlpPath);
  let jsRuntimeFlag = "";

  function commonFlags(extra = {}) {
    const flags = {
      noPlaylist: true,
      noWarnings: true,
      noUpdate: true,
      forceIpv4: true,
      newline: true,
      retries: 10,
      fragmentRetries: 10,
      extractorArgs: "youtube:player_client=web,web_safari,tv,mweb,ios,android",
      ...extra
    };
    if (ffmpegPath && !flags.ffmpegLocation) flags.ffmpegLocation = ffmpegPath;
    if (jsRuntimeFlag && !flags.jsRuntimes) flags.jsRuntimes = jsRuntimeFlag;
    if (!flags.remoteComponents) flags.remoteComponents = "ejs:github";
    return flags;
  }

  async function prepare(dataRoot) {
    const toolsDir = path.join(dataRoot, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    const destName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
    const destPath = path.join(toolsDir, destName);
    if (!fileExists(destPath) && fileExists(ytDlpPath) && ytDlpPath !== destPath) {
      try {
        fs.copyFileSync(ytDlpPath, destPath);
      } catch (_err) {
        // keep bundled path if copy fails
      }
    }
    if (fileExists(destPath)) ytDlpPath = destPath;

    await runQuiet(ytDlpPath, ["-U"], 90000);

    const nodePath = findNodeExecutable();
    if (nodePath) {
      jsRuntimeFlag = `node:${nodePath}`;
    } else {
      const denoPath = await ensureDeno(toolsDir);
      if (denoPath) jsRuntimeFlag = `deno:${denoPath}`;
    }
    return { ytDlpPath, jsRuntimeFlag };
  }

  return {
    commonFlags,
    prepare,
    get binaryPath() {
      return ytDlpPath;
    }
  };
}

module.exports = {
  resolveAsarUnpackedPath,
  findNodeExecutable,
  createEngine
};
