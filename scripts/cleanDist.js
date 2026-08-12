const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");

function removePath(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed: ${path.relative(process.cwd(), target)}`);
}

if (!fs.existsSync(distDir)) {
  console.log("dist/ not found — nothing to clean.");
  process.exit(0);
}

const entries = fs.readdirSync(distDir);
for (const name of entries) {
  const full = path.join(distDir, name);
  // Keep nothing from previous builds: installers, unpacked app, maps, yml, debug.
  removePath(full);
}

console.log("Cleaned dist/ for fresh version build.");
