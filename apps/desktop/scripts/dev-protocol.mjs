// Development only (macOS): let the dev Electron app open qhint:// links.
// macOS reads link types from the app bundle's Info.plist, so this adds ours to the Electron.app
// that `pnpm dev` runs (inside node_modules; a reinstall undoes it), then tells Launch Services.
// Packaged builds declare the link type in their own Info.plist instead.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform !== 'darwin') process.exit(0);

const electronBinary = createRequire(import.meta.url)('electron');
const appBundle = join(dirname(electronBinary), '..', '..');
const plist = join(appBundle, 'Contents', 'Info.plist');
const buddy = (cmd) =>
  execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { encoding: 'utf8' });

let current = '';
try {
  current = buddy('Print :CFBundleURLTypes');
} catch {
  /* none yet */
}
if (current.includes('qhint')) process.exit(0);

if (!current) buddy('Add :CFBundleURLTypes array');
const n = (current.match(/CFBundleURLName/g) ?? []).length;
buddy(`Add :CFBundleURLTypes:${n} dict`);
buddy(`Add :CFBundleURLTypes:${n}:CFBundleURLName string Qhint`);
buddy(`Add :CFBundleURLTypes:${n}:CFBundleURLSchemes array`);
buddy(`Add :CFBundleURLTypes:${n}:CFBundleURLSchemes:0 string qhint`);
execFileSync(
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
  ['-f', appBundle],
);
console.log('registered qhint:// links for the development app');
