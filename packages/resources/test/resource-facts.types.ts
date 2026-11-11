import { FactType } from '@weiliang0121/capix-changes';
import { Resource, ResourceOffer, Resources, type ResourceOperation, type ResourceEventConsumer } from '@weiliang0121/capix-resources';

type CounterChanged = { kind: 'counter-changed'; count: number };
type LabelChanged = { kind: 'label-changed'; text: string };
const changed = new FactType<CounterChanged>('counter-changed');
declare const operation: ResourceOperation;
const publisher = operation.facts(changed)!;
publisher.publish({ kind: 'counter-changed', count: 1 });
// @ts-expect-error a narrow publisher cannot accept another source's event by widening.
const widened: ResourceEventConsumer<CounterChanged | LabelChanged> = publisher;
declare const allEvents: ResourceEventConsumer<CounterChanged | LabelChanged>;
const narrowed: ResourceEventConsumer<CounterChanged> = allEvents;
// @ts-expect-error the token determines the publisher event without a second type annotation.
publisher.publish({ kind: 'label-changed', text: 'wrong' });
// @ts-expect-error the fixed source vocabulary still requires its body fields.
publisher.publish({ kind: 'counter-changed' });
// @ts-expect-error an explicit incompatible event parameter cannot widen the token.
operation.facts<CounterChanged | LabelChanged>(changed);

const offer = new ResourceOffer({
  methods: {
    increment(source: { count: number }, amount: number, current: ResourceOperation) {
      source.count += amount;
      const facts = current.facts(changed);
      if (facts) {
        facts.publish({ kind: 'counter-changed', count: source.count });
        // @ts-expect-error the ordinary method adapter keeps the exact source event type.
        facts.publish({ kind: 'label-changed', text: 'wrong' });
        // @ts-expect-error ordinary method publishers cannot broaden to another event vocabulary.
        const broad: ResourceEventConsumer<CounterChanged | LabelChanged> = facts;
        void broad;
      }
      return source.count;
    },
  },
});
const access = new Resources()
  .register(new Resource({ count: 0 }), offer)
  .bind({ counter: offer.request() })
  .open();
const output: Promise<number> = access.endpoints.counter.increment(1);
// @ts-expect-error adding fact publication does not erase the ordinary method input type.
access.endpoints.counter.increment('wrong');
// @ts-expect-error adding fact publication does not erase the ordinary method result type.
const wrongOutput: Promise<string> = access.endpoints.counter.increment(1);
void output;
void wrongOutput;
void widened;
void narrowed;
