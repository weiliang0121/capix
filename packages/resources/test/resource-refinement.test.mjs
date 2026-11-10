import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resource, ResourceOffer, ResourceBinding, Resources } from '@weiliang0121/capix-resources';
const failures = { isProtected: () => false, isCancellation: () => false, describe: (error) => ({ message: String(error) }) };
function fixture() {
  const counters = { capture: 0, refine: 0 };
  const offer = new ResourceOffer({
    capture(source) {
      counters.capture++;
      return Object.freeze({ allowed: Object.freeze([...source.allowed]) });
    },
    refine(source, allowed) {
      counters.refine++;
      if (allowed.some((value) => !source.allowed.includes(value))) throw new Error('Cannot widen access');
      return Object.freeze({ allowed: Object.freeze([...allowed]) });
    },
    methods: { read: (source) => source.allowed },
  });
  const deps = { bounded: offer.request() };
  const parent = new Resources()
    .register(new Resource({ allowed: ['a', 'b'] }), offer)
    .bind(deps)
    .open({ contextId: 'parent', failures, validate() {} });
  return { offer, deps, parent, counters };
}
test('refinement is fixed before input can change and does not mutate parent material', async () => {
  const { offer, deps, parent, counters } = fixture();
  const input = { allowed: ['a'] };
  const supply = parent.supply.refine(input, [offer.refine((value) => value.allowed)]);
  input.allowed.push('b');
  const child = ResourceBinding.fromSupply(deps, supply).open({ contextId: 'child', failures, validate() {} });
  assert.deepEqual(await child.endpoints.bounded.read(), ['a']);
  assert.deepEqual(await parent.endpoints.bounded.read(), ['a', 'b']);
  assert.deepEqual(counters, { capture: 1, refine: 1 });
  child.close();
  parent.close();
});
test('refinement refuses unsupported offers, undeclared supply and fabricated or copied rules', () => {
  const ordinary = new ResourceOffer({ expose: (source) => source });
  assert.throws(() => ordinary.refine(() => null), /does not support refinement/);
  const { offer, parent, counters } = fixture();
  const issued = offer.refine((input) => input.allowed);
  const forged = { offer: issued.offer, apply: () => ({ allowed: ['outside'] }) };
  for (const rule of [forged, { ...issued }, Object.create(issued)]) assert.throws(() => parent.supply.refine({ allowed: ['outside'] }, [rule]), /not issued by an offer/);
  const other = new Resources()
    .register(new Resource(null), ordinary)
    .bind({ ordinary: ordinary.request() })
    .open({ contextId: 'other', failures, validate() {} });
  assert.throws(() => other.supply.refine(null, [issued]), /Refined resource is not requested|not supplied/);
  assert.equal(issued.apply, undefined);
  assert.ok(Object.isFrozen(issued));
  assert.throws(() => {
    issued.offer = { name: 'substituted' };
  }, TypeError);
  assert.deepEqual(counters, { capture: 0, refine: 0 });
  assert.throws(() => parent.supply.refine({ allowed: ['outside'] }, [issued]), /Cannot widen access/);
  other.close();
  parent.close();
});
