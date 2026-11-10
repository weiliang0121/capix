import assert from 'node:assert/strict';

import { test } from 'node:test';

import { readFile } from 'node:fs/promises';

test('generic view has no transcript, memory or Observer active-membership policy', async () => {
  const exported = await import('@weiliang0121/capix-view');
  for (const name of ['Transcript', 'Memories', 'TranscriptViewSource', 'MemoryViewSource', 'ActiveView', 'ActiveViewResource', 'initialActiveView', 'appendActiveView', 'freezeActiveView']) assert.equal(name in exported, false, `@weiliang0121/capix-view must not own ${name}`);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-resources']);
});
