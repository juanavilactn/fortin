/**
 * electron-builder `afterPack` hook for macOS.
 *
 * macOS only delivers system notifications from a bundle that carries a real
 * code signature. The Electron runtime this project ships is linker-signed
 * (flags 0x20002, Info.plist not bound) and electron-builder skips signing when
 * no identity is available, so the packed app would look unsigned to the
 * system and every notification would be dropped without a word.
 *
 * This hook gives the bundle a local ad-hoc signature in that case. A real
 * identity still wins: the hook runs before electron-builder signs, and it
 * leaves the app untouched when the packed bundle already verifies.
 */

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CODESIGN = 'codesign';

/** A linker-signed or unsigned bundle fails this check; a signed one passes. */
function isSigned(appPath) {
  try {
    execFileSync(CODESIGN, ['--verify', '--strict', appPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

exports.default = async function signMacApp(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app');
  if (isSigned(appPath)) return;

  console.log('  • ad-hoc signing   ' + path.basename(appPath));
  execFileSync(CODESIGN, ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
