// node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, which
// makes every spawn fail with "posix_spawnp failed". Restore it after install.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export function fixSpawnHelper() {
  let root;
  try {
    root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return [];
  }
  const fixed = [];
  for (const dir of ['prebuilds', path.join('build', 'Release')]) {
    const base = path.join(root, dir);
    if (!fs.existsSync(base)) continue;
    const candidates = dir === 'prebuilds' ? fs.readdirSync(base).map((d) => path.join(base, d, 'spawn-helper')) : [path.join(base, 'spawn-helper')];
    for (const file of candidates) {
      try {
        const { mode } = fs.statSync(file);
        if ((mode & 0o111) !== 0o111) {
          fs.chmodSync(file, mode | 0o755);
          fixed.push(file);
        }
      } catch {}
    }
  }
  return fixed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const f of fixSpawnHelper()) console.log(`made executable: ${f}`);
}
