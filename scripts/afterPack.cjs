// electron-builder afterPack hook: ad-hoc code-sign the macOS app.
// We have no Apple Developer ID, and repacking/renaming the bundle invalidates
// Electron's original signature — which makes arm64 macOS reject the app as
// "damaged". An ad-hoc signature ("-") produces a valid signature matching the
// modified bundle, so it launches (Gatekeeper shows the normal "unidentified
// developer" prompt → right-click → Open).
const { execSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename; // "Bonsai"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] ad-hoc signing ${appPath}`);
  // --deep signs nested helpers/frameworks; --force replaces the stale signature.
  execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
  execSync(`codesign --verify --deep --strict "${appPath}"`, { stdio: 'inherit' });
  console.log('[afterPack] ad-hoc signature verified');
};
