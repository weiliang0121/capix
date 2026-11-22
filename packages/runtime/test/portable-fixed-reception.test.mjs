import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

test('fixed transcript effects use the precise successful or handled child without async context', async () => {
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      assert.notEqual(specifier, 'node:async_hooks');
      if (specifier === '#reception-scope') return nextResolve(specifier, { ...context, conditions: context.conditions.filter((value) => value !== 'node') });
      return nextResolve(specifier, context);
    },
  });
  try {
    const { Node, Scene, Runner, Resources } = await import('@weiliang0121/capix-runtime');
    const { Transcript, TranscriptResource } = await import('@weiliang0121/capix-transcript');
    const transcript = new Transcript();
    const resources = new Resources().register(TranscriptResource.append, transcript);
    const source = new Node({
      run(work) {
        if (work.input === 'failed') throw new Error('expected failure');
        return work.input;
      },
    });
    let expired;
    const scene = new Scene({
      deps: { messages: TranscriptResource.append.request() },
      async run(work) {
        const messages = work.resources.messages;
        if (work.input === 'expired') return messages.applyFixed({ position: 'late', messages: [{ role: 'assistant', content: 'too late' }] }, expired);
        const append = async (content, permit) => {
          await Promise.resolve();
          expired = permit;
          return messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content }] }, permit);
        };
        const call = work.children.create(source, 'successful');
        await call.run();
        const first = await call.accept(append);
        const second = await work.children.source.invoke('failed', { result: { failed: (error, permit) => append(error.message, permit) } });
        return [first.start, second.start];
      },
    }).add({ source });
    const runner = new Runner(scene, resources).build();
    assert.deepEqual(await runner.run('collect'), [0, 1]);
    const [success, handled] = transcript.exportState().appends.map((item) => item.request.operation);
    assert.equal(success.parentContextId, handled.parentContextId);
    assert.notEqual(success.childContextId, handled.childContextId);
    assert.equal(transcript.get(0).content, 'successful');
    assert.equal(transcript.get(1).content, 'expected failure');
    await assert.rejects(runner.run('expired'), (error) => error.name === 'ResourcePortError' && /active direct-child reception permit/.test(error.cause?.message));
    assert.equal(transcript.length, 2);
  } finally {
    hook.deregister();
  }
});
