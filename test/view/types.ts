import { Resource, ResourceOffer, Resources } from '@capix/resources';
import { Transcript, TranscriptViewSource } from '@capix/transcript';
import { Memories, MemoryViewSource } from '@capix/memory';
import { View, openView, openViewManager, type SyncViewSource, type ViewSource, type ViewState, type SourceStamp } from '@capix/view';

declare function expectType<Value>(value: Value): void;
declare const stamp: SourceStamp;

const transcript = new Transcript([{ role: 'user', content: 'Input' }]);
const memories = new Memories(transcript);
const skills: SyncViewSource<string, { title: string }, { text: string }> = {
  index: () => ({ stamp, entries: [{ key: 'translate', summary: { title: 'Translate' } }] }),
  read: (keys, expected) => ({ stamp: expected, entries: keys.map((key) => ({ key, value: { text: 'Translate faithfully' } })) }),
  check: () => true,
};
const sources = { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories), skills };
type Sources = typeof sources;
const state: ViewState<Sources> = {
  revision: 0,
  sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' }, skills: { id: 'skills', scope: 'whole' } },
  members: [
    { source: 'messages', key: 0 },
    { source: 'memories', key: 'memory-id' },
    { source: 'skills', key: 'translate' },
  ],
};
const view = new View<Sources>(state);

// The schema may be inferred from concrete entity adapters, while each call
// borrows only their public read contracts from its own resource window.
const controlled = {
  messages: {
    index: () => sources.messages.index(),
    read: (keys: readonly number[], expected: SourceStamp) => sources.messages.read(keys, expected),
    check: (expected: SourceStamp) => sources.messages.check(expected),
  },
  memories: {
    index: () => sources.memories.index(),
    read: (keys: readonly string[], expected: SourceStamp) => sources.memories.read(keys, expected),
    check: (expected: SourceStamp) => sources.memories.check(expected),
  },
  skills,
};
view.index(controlled);
view.capture(controlled);
const controlledIndex = view.indexSync(controlled);
view.captureSync(controlled, controlledIndex);
view.applySync(controlled, { basis: controlledIndex.basis, members: [{ source: 'messages', key: 0 }] });

const asyncControlled = {
  ...controlled,
  messages: {
    async index() {
      return controlled.messages.index();
    },
    async read(keys: readonly number[], expected: SourceStamp) {
      return controlled.messages.read(keys, expected);
    },
    async check(expected: SourceStamp) {
      return controlled.messages.check(expected);
    },
  },
};
view.index(asyncControlled);
view.capture(asyncControlled);
// @ts-expect-error asynchronous wrappers retain the synchronous access restriction
view.indexSync(asyncControlled);
// @ts-expect-error management cannot infer away an asynchronous source wrapper
view.applySync(asyncControlled, { basis: controlledIndex.basis, members: [] });

declare const wrongMessageKeys: SyncViewSource<string, { role: 'user' | 'assistant' }, { role: 'user' | 'assistant'; content: string }>;
declare const wrongMessageValues: SyncViewSource<number, { role: 'user' | 'assistant' }, { role: 'user' | 'assistant'; content: number }>;
// @ts-expect-error source-contract wrappers must preserve the schema's key type
view.capture({ ...controlled, messages: wrongMessageKeys });
// @ts-expect-error source-contract wrappers must preserve the schema's value type
view.capture({ ...controlled, messages: wrongMessageValues });

const wrappedRead = new ResourceOffer({ expose: (origin: { view: View<Sources>; sources: typeof controlled }, activity) => openView(origin.view, origin.sources, activity) });
const wrappedManage = new ResourceOffer({ expose: (origin: { view: View<Sources>; sources: typeof controlled }, activity) => openViewManager(origin.view, origin.sources, activity) });
const wrappedAccess = new Resources()
  .register(new Resource({ view, sources: controlled }), wrappedRead)
  .register(new Resource({ view, sources: controlled }), wrappedManage)
  .bind({ read: wrappedRead.request(), manage: wrappedManage.request() })
  .open();
wrappedAccess.endpoints.read.capture().then((result) => {
  for (const entry of result.entries) if (entry.source === 'messages') expectType<string>(entry.value.content);
});
new ResourceOffer({
  expose: (_origin: null, activity) => {
    openView(view, asyncControlled, activity);
    // @ts-expect-error manager construction requires synchronous wrappers even for a concrete adapter schema
    return openViewManager(view, asyncControlled, activity);
  },
});

const index = view.indexSync(sources);
for (const entry of index.entries) {
  if (entry.source === 'messages') {
    expectType<number>(entry.key);
    expectType<'user' | 'assistant'>(entry.summary.role);
    // @ts-expect-error directory summaries cannot be treated as bodies
    entry.summary.content;
  }
  if (entry.source === 'skills') {
    expectType<string>(entry.key);
    expectType<string>(entry.summary.title);
    // @ts-expect-error the source slot determines the summary type
    entry.summary.role;
  }
}
const snapshot = view.captureSync(sources, index);
for (const entry of snapshot.entries) {
  if (entry.source === 'messages') {
    expectType<number>(entry.key);
    expectType<string>(entry.value.content);
    // @ts-expect-error message values are not memory values
    entry.value.topic;
  }
  if (entry.source === 'memories') {
    expectType<string>(entry.key);
    expectType<string>(entry.value.topic);
    expectType<readonly number[]>(entry.value.sourceIndexes);
    // @ts-expect-error memory keys are not message indexes
    expectType<number>(entry.key);
  }
  if (entry.source === 'skills') {
    expectType<string>(entry.value.text);
    // @ts-expect-error skills preserve their own value contract
    entry.value.sourceIndexes;
  }
}
view.applySync(sources, {
  basis: index.basis,
  members: [
    { source: 'messages', key: 1 },
    { source: 'skills', key: 'review' },
  ],
});
// @ts-expect-error source names are restricted to the configured slots
view.applySync(sources, { basis: index.basis, members: [{ source: 'other', key: 'x' }] });
// @ts-expect-error message member keys remain numbers
view.applySync(sources, { basis: index.basis, members: [{ source: 'messages', key: '0' }] });
// @ts-expect-error memory member keys remain strings
view.applySync(sources, { basis: index.basis, members: [{ source: 'memories', key: 0 }] });
// @ts-expect-error configured sources cannot be omitted at access time
view.index({ messages: sources.messages, skills });
// @ts-expect-error adapters retain their source-specific read key contract
sources.messages.read(['0'], stamp);
// @ts-expect-error memory adapters do not accept message indexes
sources.memories.read([0], stamp);

const read = new ResourceOffer({ expose: (origin: { view: View<Sources>; sources: Sources }, activity) => openView(origin.view, origin.sources, activity) });
const manage = new ResourceOffer({ expose: (origin: { view: View<Sources>; sources: Sources }, activity) => openViewManager(origin.view, origin.sources, activity) });
const origin = new Resource({ view, sources });
const access = new Resources().register(origin, read).register(origin, manage).bind({ read: read.request(), manage: manage.request() }).open();
const pending = access.endpoints.read.capture();
pending.then((result) => {
  for (const entry of result.entries) if (entry.source === 'skills') expectType<string>(entry.value.text);
});
// @ts-expect-error read access has no management operation
access.endpoints.read.apply({ basis: index.basis, members: [] });
access.endpoints.manage.apply({ basis: index.basis, members: [{ source: 'messages', key: 0 }] });
// @ts-expect-error resource management preserves source-key correlation
access.endpoints.manage.apply({ basis: index.basis, members: [{ source: 'skills', key: 0 }] });

const asynchronous: ViewSource<string, { title: string }, { text: string }> = {
  async index() {
    return skills.index();
  },
  async read(keys, expected) {
    return skills.read(keys, expected);
  },
  async check(expected) {
    return skills.check(expected);
  },
};
const asyncSources = { skills: asynchronous };
const asyncView = new View<typeof asyncSources>({ revision: 0, sources: { skills: { id: 'skills', scope: 'whole' } }, members: [{ source: 'skills', key: 'translate' }] });
asyncView.capture(asyncSources).then((result) => {
  for (const entry of result.entries) expectType<string>(entry.value.text);
});
// @ts-expect-error asynchronous sources cannot claim synchronous indexing
asyncView.indexSync(asyncSources);
// @ts-expect-error asynchronous source checking cannot participate in synchronous management
asyncView.applySync(asyncSources, { basis: { viewRevision: 0, sources: { skills: stamp } }, members: [] });
new ResourceOffer({
  expose: (_origin: null, activity) => {
    // @ts-expect-error the manage endpoint requires synchronous source contracts
    return openViewManager(asyncView, asyncSources, activity);
  },
});
