import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resources, Resource, ResourceOffer } from '@weiliang0121/capix-resources';

test('a required resource provenance failure stays protected across child delivery', async () => {
  const { Scene, Node, Runner, Resources: RuntimeResources } = await import('@weiliang0121/capix-runtime');
  const offer = new ResourceOffer({
    expose(_source, activity) {
      return {
        read() {
          return activity.operate('read', {}, () => activity.reception());
        },
      };
    },
  });
  const child = new Node({ deps: { value: offer.request() }, run: (work) => work.resources.value.read() });
  let handled = false;
  const scene = new Scene({
    run: (work) =>
      work.children.invoke(child, null, {
        result: {
          failed() {
            handled = true;
            return 'masked';
          },
        },
      }),
  }).add(child);
  await assert.rejects(new Runner(scene, new RuntimeResources().register(new Resource(null), offer)).build().run(null));
  assert.equal(handled, false);
});
