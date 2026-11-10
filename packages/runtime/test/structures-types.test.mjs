import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Runner, Resources } from '@weiliang0121/capix-runtime';

test('a processing callback cannot call a member outside its actual registration', async () => {
  let called = 0;
  const child = new Node({ run: () => ++called });
  const scene = new Scene({ run: (work) => work.children.invoke(child, null) });
  const runner = new Runner(scene, new Resources()).build();
  await assert.rejects(runner.run(null), /not declared|not registered/);
  assert.equal(called, 0);
  assert.equal(runner.isRunning, false);
});
