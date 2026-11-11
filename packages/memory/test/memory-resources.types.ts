import { Memories, MemoryViewSource, memoryResources, type MemoryEvent } from '@weiliang0121/capix-memory';
import { Resources, Resource } from '@weiliang0121/capix-resources';

type Metadata = { label: string; tags: string[] };
const memories = new Memories<Metadata>({ contentContract: { key: 'test', version: 1 } });
const offers = memoryResources<Metadata>();
const resources = new Resources().register(new Resource(memories), offers.read).register(new Resource(memories), offers.apply);
const access = resources.bind({ read: offers.read.request(), write: offers.apply.request() }).open();
access.endpoints.write.apply([{ action: 'create', value: { content: 'text', metadata: { label: 'a', tags: ['b'] } } }]);
// @ts-expect-error metadata is not erased by the offer
access.endpoints.write.apply([{ action: 'create', value: { content: 'text', metadata: { label: 1, tags: [] } } }]);
const read = access.endpoints.read.read('item');
if (read) access.endpoints.write.apply([{ action: 'update', memoryId: read.id, value: read.value }]);
const label: string | undefined = read?.value.metadata?.label;
// @ts-expect-error fixed nested metadata is deeply readonly
read?.value.metadata?.tags.push('change');
// @ts-expect-error read endpoint exposes no mutation
access.endpoints.read.apply([]);
const snapshot = access.endpoints.read.snapshot();
// @ts-expect-error snapshot items are deeply readonly
snapshot.items[0]!.value.metadata!.tags.push('change');
const changed = access.endpoints.write.apply([]).changed;
// @ts-expect-error application items are deeply readonly
changed[0]!.value.metadata!.tags.push('change');
const source = new MemoryViewSource(memories);
const sourceRead = source.read(['item'], source.index().stamp);
const viewLabel: string | undefined = sourceRead.entries[0]?.value.value.metadata?.label;
// @ts-expect-error View reads preserve deep immutability
sourceRead.entries[0]!.value.value.metadata!.tags.push('change');
const plain = memoryResources();
// @ts-expect-error default metadata contract accepts no author metadata
new Resources().register(new Resource(memories), plain.apply);
// @ts-expect-error the read offer also retains its metadata contract
new Resources().register(new Resource(memories), plain.read);
// @ts-expect-error generic source metadata must match the offer
new Resources().register(new Resource(new Memories<{ label: number; tags: string[] }>()), offers.apply);
const plainMemory = new Memories();
// @ts-expect-error metadata requires an explicit generic contract
plainMemory.apply([{ action: 'create', value: { content: 'text', metadata: { label: 'a' } } }]);
void label;
void viewLabel;

const event = {} as MemoryEvent<Metadata>;
// @ts-expect-error captured memory event metadata is deeply readonly
event.change.value.metadata!.tags.push('change');
