import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('protocol owns explicit wire admission, not entity APIs or host projections', async () => {
  const protocol = await import('@weiliang0121/capix-protocol');
  assert.deepEqual(Object.keys(protocol), ['acceptTranscriptUpdate']);
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.exports), ['.']);
  assert.deepEqual(Object.keys(manifest.dependencies), ['@weiliang0121/capix-contracts']);
  for (const path of ['content', 'invocation', 'recording', 'observer', 'conversation']) {
    await assert.rejects(import(`@weiliang0121/capix-protocol/${path}`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
});
