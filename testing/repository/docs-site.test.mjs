import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import site from '../../docs/.vitepress/config.mjs';
import { checkPackageReadme, checkReference } from '../../scripts/docs/check.mjs';

const docs = new URL('../../docs/', import.meta.url);

test('the home page and top-level navigation lead to the developer journal and its articles', async () => {
  const [home, journal] = await Promise.all([readFile(new URL('index.md', docs), 'utf8'), readFile(new URL('essays/index.md', docs), 'utf8')]);
  const entry = site.themeConfig.nav.find(({ text }) => text === '开发者手记');
  assert.equal(entry?.link, '/essays/');
  assert.match(home, /^\s+text: 开发者手记\n\s+link: \/essays\/$/m);
  const activeMatch = new RegExp(entry.activeMatch);
  assert.match('/essays/', activeMatch);
  assert.doesNotMatch('/guide/getting-started', activeMatch);

  const articlePaths = ['essays/tool-loop-boundaries', 'essays/intelligent-organization', 'scenarios/multi-agent'];
  for (const path of articlePaths) {
    await readFile(new URL(`${path}.md`, docs), 'utf8');
    const relativeLink = path.startsWith('essays/') ? `./${path.slice('essays/'.length)}.md` : `../${path}.md`;
    assert.ok(journal.includes(`](${relativeLink})`), `The journal must link to /${path}`);
    assert.match(`/${path}`, activeMatch);
  }

  for (const section of ['/essays/', '/scenarios/']) {
    const group = site.themeConfig.sidebar[section]?.find(({ text }) => text === '开发者手记');
    const links = group?.items.map(({ link }) => link);
    for (const route of ['/essays/', ...articlePaths.map((path) => `/${path}`)]) {
      assert.ok(links?.includes(route), `The ${section} sidebar must link to ${route}`);
    }
  }
});

test('the multi-agent scenario imports its runnable example', async () => {
  const scenario = await readFile(new URL('scenarios/multi-agent.md', docs), 'utf8');
  assert.match(scenario, /^<<<[ \t]+\.\.\/\.\.\/examples\/parallel-review\.mjs(?=[\s#{]|$)/m, 'The scenario must import source from its runnable example');
});

test('public site references reject private repository paths and missing example imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capix-docs-'));
  try {
    const docs = join(root, 'docs');
    await mkdir(docs);
    await mkdir(join(root, 'examples'));
    await writeFile(join(root, 'examples', 'hello.mjs'), 'export const hello = 1;');
    const options = { repositoryRoot: root, docsRoot: docs };
    const file = join(docs, 'index.md');
    checkReference(file, '../examples/hello.mjs', { ...options, snippet: true });
    assert.throws(() => checkReference(file, '../../private/README.md', options), /leaves public repository/);
    assert.throws(() => checkReference(file, '../examples/missing.mjs', { ...options, snippet: true }), /missing snippet/);
    assert.throws(() => checkReference(file, './missing.md', options), /missing link/);
    const readme = join(root, 'packages', 'example', 'README.md');
    const packageOptions = { ...options, packageReadme: true };
    const exampleUrl = 'https://github.com/weiliang0121/capix/blob/main/examples/';
    checkReference(readme, exampleUrl + 'hello.mjs', packageOptions);
    assert.throws(() => checkReference(readme, exampleUrl + 'removed.mjs', packageOptions), /missing link/);
    assert.throws(() => checkReference(readme, '../../examples/hello.mjs', packageOptions), /unavailable in the installed package/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('package README names its npm package and its current public entry points', () => {
  const name = '@weiliang0121/capix-example';
  const manifest = { name, engines: { node: '>=22.23.2' }, exports: { '.': {}, './data': {} } };
  const readme = [`# ${name}`, 'Node.js `>=22.23.2`', `npm install ${name}`, '`@weiliang0121/capix-example` and `@weiliang0121/capix-example/data`'].join('\n');
  checkPackageReadme(readme, manifest);
  assert.throws(() => checkPackageReadme(readme.replace('22.23.2', '18'), manifest), /Node.js requirement/);
  assert.throws(() => checkPackageReadme(readme.replace('npm install', 'install'), manifest), /missing npm install/);
  assert.throws(() => checkPackageReadme(readme.replace('/data', '/old'), manifest), /documented entry points/);
});

test('public snippet regions must exist once, close correctly and contain rendered content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capix-docs-regions-'));
  try {
    const docs = join(root, 'docs');
    await mkdir(docs);
    await mkdir(join(root, 'examples'));
    const source = join(root, 'examples', 'hello.mjs');
    const file = join(docs, 'index.md');
    const options = { repositoryRoot: root, docsRoot: docs, snippet: true };
    const cases = [
      ['missing', 'export const hello = 1;', /must exist exactly once/],
      ['empty', '// #region hello\n  \n// #endregion hello', /empty region/],
      ['markers only', '// #region hello\n// #region inner\n// #endregion inner\n// #endregion hello', /empty region/],
      ['duplicate', '// #region hello\none();\n// #endregion hello\n// #region hello\ntwo();\n// #endregion hello', /must exist exactly once/],
      ['unclosed', '// #region hello\nhello();', /unclosed region/],
      ['crossed nesting', '// #region hello\n// #region inner\nhello();\n// #endregion hello\n// #endregion inner', /mismatched closing marker/],
    ];
    for (const [name, content, expected] of cases) {
      await writeFile(source, content);
      assert.throws(() => checkReference(file, '../examples/hello.mjs#hello', options), expected, name);
    }
    await writeFile(source, '  // #region hello\r\n  // region inner\r\n  hello();\r\n  // endregion inner\r\n  // #endregion hello');
    checkReference(file, '../examples/hello.mjs#hello', options);
    checkReference(file, '../examples/hello.mjs#inner', options);
    checkReference(file, '../examples/hello.mjs', options);
    await writeFile(source, ' \n\t');
    assert.throws(() => checkReference(file, '../examples/hello.mjs', options), /empty snippet/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
