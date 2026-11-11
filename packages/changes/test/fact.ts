import { FactType, type Fact } from '@weiliang0121/capix-changes';
import type { Stable } from '@weiliang0121/capix-contracts';

type Event = { kind: 'counter'; value: { count: number } };
type Other = { kind: 'label'; text: string };
const counter = new FactType<Event>('counter');
const label = new FactType<Other>('label');
const fact: Fact = counter.create({ kind: 'counter', value: { count: 1 } });
counter.match(fact, (event) => {
  const value: Stable<Event> = event;
  // @ts-expect-error the delivered event is deeply fixed.
  event.value.count++;
  // @ts-expect-error matching does not expose another source's fields.
  event.text;
  void value;
});
// @ts-expect-error bodies have no public erased value escape hatch.
fact.value;
// @ts-expect-error a shell cannot forge an opaque fact.
const forged: Fact = { name: 'counter' };
// @ts-expect-error source tokens do not accept another event type.
counter.create({ kind: 'label', text: 'wrong' });
// @ts-expect-error callback input remains bound to the exact source vocabulary.
counter.match(fact, (event: Other) => undefined);
// @ts-expect-error type tokens are invariant rather than widening to a union.
const widened: FactType<Event | Other> = counter;
// @ts-expect-error a union token cannot narrow to one event vocabulary.
const narrowed: FactType<Event> = new FactType<Event | Other>();
function create<Event>(type: FactType<Event>, event: Event): Fact {
  return type.create(event);
}
// @ts-expect-error inference cannot widen the source type from an incompatible event.
create(counter, { kind: 'label', text: 'wrong' });
function paired<Event>(left: FactType<Event>, right: FactType<Event>): void {}
// @ts-expect-error incompatible tokens cannot infer a shared union event type.
paired(counter, label);
void forged;
void widened;
void narrowed;
