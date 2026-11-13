import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkReference } from '../../scripts/docs/check.mjs';

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
