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
      '-framework',
      'ScreenCaptureKit',
    ],
    { stdio: 'inherit' },
  );
} else if (process.platform === 'win32') {
  // The C# compiler that ships with Windows (.NET Framework 4): nothing to install.
  const src = join(root, 'native/win/QhintAX.cs');
  const out = join(root, 'native/bin/qhint-ax.exe');
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) process.exit(0);
  const fw = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
  );
  const csc = join(fw, 'csc.exe');
  if (!existsSync(csc)) {
    console.log('accessibility helper: C# compiler not found; the guide will use screenshots');
    process.exit(0);
  }
  mkdirSync(dirname(out), { recursive: true });
  console.log('building accessibility helper (csc)…');
  const refs = ['WPF/UIAutomationClient.dll', 'WPF/UIAutomationTypes.dll', 'WPF/WindowsBase.dll'];
  execFileSync(
    csc,
    [
      '/nologo',
      '/optimize+',
      '/target:exe',
      '/platform:anycpu',
      `/out:${out}`,
      ...refs.map((r) => `/reference:${join(fw, r)}`),
      src,
    ],
    { stdio: 'inherit' },
  );
} else {
  console.log(`accessibility helper: not available on ${process.platform}`);
}
