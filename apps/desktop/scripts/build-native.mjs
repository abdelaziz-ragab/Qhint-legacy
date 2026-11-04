// Builds the native accessibility helper for this OS (macOS: Swift). Skips if up to date.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'darwin') {
  const src = join(root, 'native/mac/QhintAX.swift');
  const out = join(root, 'native/bin/qhint-ax');
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) process.exit(0);
  mkdirSync(dirname(out), { recursive: true });
  console.log('building accessibility helper (swiftc)…');
  execFileSync(
    'swiftc',
    [
      '-O',
      '-swift-version',
      '5',
      '-o',
      out,
      src,
      '-framework',
      'AppKit',
      '-framework',
      'ApplicationServices',
    ],
    { stdio: 'inherit' },
  );
} else {
  // Windows helper (UI Automation) comes next; until then the guide uses screenshots there.
  console.log(`accessibility helper: not built for ${process.platform} yet`);
}
