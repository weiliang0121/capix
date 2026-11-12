import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docs = resolve(root, 'docs');

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith('.'))
      .map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : [];
      }),
  );
  return groups.flat();
}

export function checkReference(file, href, { snippet = false, repositoryRoot = root, docsRoot = docs } = {}) {
  if (!href || /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) return;
  const target = decodeURIComponent(href.split(/[?#]/)[0]);
  const path = target.startsWith('/') ? resolve(docsRoot, `.${target}`) : resolve(dirname(file), target);
  const fromRoot = relative(repositoryRoot, path);
  assert.ok(fromRoot !== '..' && !fromRoot.startsWith('../'), `${file}: reference leaves public repository: ${href}`);
  const candidates = snippet ? [path] : extname(path) ? [path] : [path, `${path}.md`, resolve(path, 'index.md')];
  assert.ok(
    candidates.some((candidate) => existsSync(candidate)),
    `${relative(repositoryRoot, file)}: missing ${snippet ? 'snippet' : 'link'} ${href}`,
  );
  if (snippet) assert.ok(relative(resolve(repositoryRoot, 'examples'), path).split('/')[0] !== '..', `${file}: snippet must come from public examples`);
}

export async function checkDocs() {
  const files = [...(await markdownFiles(docs)), resolve(root, 'README.md'), resolve(root, 'examples/README.md')];
  const snippets = new Set();
  const failures = [];
  const check = (file, href, options) => {
    try {
      checkReference(file, href, options);
    } catch (error) {
      failures.push(error.message);
    }
  };
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/(?:\.\.\/)+(?:capix-lab|capix-notes|capix-explorations)(?:\/|[\s`'"])/.test(source)) failures.push(`${relative(root, file)}: contains a private sibling repository path`);
    const prose = source.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
    for (const match of prose.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) check(file, match[1]);
    for (const match of prose.matchAll(/^<<<\s+([^\s#{]+)(?:#[^\s{]+)?(?:\{[^}]*\})?(?:[ \t]*\[[^\]\n]+\])?\s*$/gm)) {
      check(file, match[1], { snippet: true });
      snippets.add(resolve(dirname(file), match[1]));
    }
  }
  const examples = (await readdir(resolve(root, 'examples'))).filter((name) => name.endsWith('.mjs'));
  assert.ok(examples.length > 0, 'Public examples must not be empty');
  for (const name of examples) {
    if (!snippets.has(resolve(root, 'examples', name))) failures.push(`Site must import public example ${name}`);
  }
  const config = await readFile(resolve(docs, '.vitepress/config.mjs'), 'utf8');
  for (const match of config.matchAll(/link:\s*'([^']+)'/g)) check(resolve(docs, 'index.md'), match[1]);
  assert.equal(failures.length, 0, failures.join('\n'));
  console.log(`Checked ${files.length} public Markdown files, site navigation and ${snippets.size} distinct example source imports`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await checkDocs();
