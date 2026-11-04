// Bundles a service into services/<name>/dist/server.mjs. Workspace packages (TypeScript source)
// are bundled in; third-party packages stay external and are installed with `pnpm deploy --prod`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const name = process.argv[2];
if (!/^[a-z-]+$/.test(name ?? '')) throw new Error('usage: build-service.mjs <service-name>');

const root = join(import.meta.dirname, '..');
const dir = join(root, 'services', name);
const collectDeps = (pkgDir, seen = new Set()) => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith('@qhint/'))
      collectDeps(join(root, 'packages', dep.slice('@qhint/'.length)), seen);
    else seen.add(dep);
  }
  return seen;
};
const external = [...collectDeps(dir)].flatMap((d) => [d, `${d}/*`]);

await build({
  entryPoints: [join(dir, 'src/server.ts')],
  outfile: join(dir, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  sourcemap: true,
  external: [...external, 'pg-native'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});
