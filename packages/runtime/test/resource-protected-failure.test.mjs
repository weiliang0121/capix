import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resource, ResourceOffer, ResourceAccessClosed, ResourcePortError } from '@weiliang0121/capix-resources';

test('a child resource closed-window failure cannot be accepted as a parent fallback', async () => {
  const { Node, Scene, Resources, Runner } = await import('@weiliang0121/capix-runtime');
  for (const wrapped of [false, true]) {
    const closed = new ResourceAccessClosed();
    const failure = wrapped ? new AggregateError([new ResourcePortError('invalid port'), closed]) : closed;
    const offer = new ResourceOffer({
      methods: {
        read() {
          throw failure;
        },
      },
    });
    let received = false;
    const child = new Node({ deps: { resource: offer.request() }, run: (work) => work.resources.resource.read(undefined) });
    const scene = new Scene({
      run: (work) =>
        work.children.invoke(child, null, {
          result: {
            failed() {
              received = true;
              return 'masked';
            },
          },
        }),
    }).add(child);
    const runner = new Runner(scene, new Resources().register(new Resource(null), offer)).build();
    await assert.rejects(runner.run(null));
    assert.equal(received, false);
  }
});
