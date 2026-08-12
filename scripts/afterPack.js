const path = require("path");
const { rcedit } = require("rcedit");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const iconPath = path.join(context.packager.projectDir, "build", "icon.ico");

  await rcedit(exePath, {
    icon: iconPath,
    "version-string": {
      CompanyName: "YouTube Downloader Pro",
      FileDescription: "YouTube Downloader Pro",
      ProductName: "YouTube Downloader Pro",
      LegalCopyright: "Copyright © YouTube Downloader Pro"
    }
  });
};
