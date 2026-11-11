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
