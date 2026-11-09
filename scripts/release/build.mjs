import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { banner, command, files, packages } from './packages.mjs';

export async function build() {
  const entries = await packages();
  for (const entry of entries) await rm(join(entry.path, 'dist'), { recursive: true, force: true });
  const filters = entries.flatMap((entry) => ['--filter', entry.manifest.name]);
  command('pnpm', [...filters, '-r', '--sort', 'exec', 'tsc', '-p', 'tsconfig.json', '--sourceMap', 'false', '--declarationMap', 'false', '--removeComments', 'true']);
  let count = 0;
  let originalBytes = 0;
  let releaseBytes = 0;
  for (const entry of entries) {
    for (const file of await files(join(entry.path, 'dist'))) {
      if (!file.endsWith('.js')) continue;
      const source = await readFile(file, 'utf8');
      const result = await transform(source, { loader: 'js', format: 'esm', target: 'es2023', minifyWhitespace: true, minifySyntax: true, minifyIdentifiers: false, keepNames: true, legalComments: 'inline', sourcemap: false, banner });
      await writeFile(file, result.code);
      originalBytes += Buffer.byteLength(source);
      releaseBytes += Buffer.byteLength(result.code);
      count++;
    }
  }
  console.log(`Built ${entries.length} packages, ${count} JS modules: ${originalBytes} -> ${releaseBytes} bytes (no bundles or source maps).`);
  return entries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await build();
