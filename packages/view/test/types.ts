import { Resource, ResourceOffer, Resources } from '@weiliang0121/capix-resources';
import { View, createViewSource, openView, openViewManager, type SyncViewSource, type ViewSource, type ViewState, type SourceStamp, type ViewSourceData, type ViewSourceOptions } from '@weiliang0121/capix-view';

declare function expectType<Value>(value: Value): void;
declare const stamp: SourceStamp;

declare const transcript: { id: string };
declare const memories: { id: string };
declare const messages: SyncViewSource<number, { role: 'user' | 'assistant' }, { role: 'user' | 'assistant'; content: string }>;
declare const memorySource: SyncViewSource<string, { topic: string }, { topic: string; content: string; sourceIndexes: readonly number[] }>;
const skills: SyncViewSource<string, { title: string }, { text: string }> = {
  index: () => ({ stamp, entries: [{ key: 'translate', summary: { title: 'Translate' } }] }),
  inspect: (keys) => ({ stamp, entries: keys.map((key) => ({ key, summary: { title: key } })) }),
  read: (keys, expected) => ({ stamp: expected, entries: keys.map((key) => ({ key, value: { text: 'Translate faithfully' } })) }),
  check: () => true,
};
const sources = { messages: messages, memories: memorySource, skills };
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
    inspect: (keys: readonly number[]) => sources.messages.inspect(keys),
    read: (keys: readonly number[], expected: SourceStamp) => sources.messages.read(keys, expected),
    check: (expected: SourceStamp) => sources.messages.check(expected),
  },
  memories: {
    index: () => sources.memories.index(),
    inspect: (keys: readonly string[]) => sources.memories.inspect(keys),
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
    async inspect(keys: readonly number[]) {
      return controlled.messages.inspect(keys);
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

const authored = createViewSource({
  id: 'settings',
  scope: 'visible',
  version: () => '0',
  keys: () => ['theme', 'language'] as const,
  inspect: (key) => ({ title: key, groups: ['settings'] }),
  read: (key) => ({ key, nested: { tags: ['local'] } }),
});
expectType<string>(authored.id);
expectType<string>(authored.scope);
const authoredIndex = authored.inspect(['theme']);
expectType<'theme' | 'language'>(authoredIndex.entries[0]!.summary.title);
const authoredValue = authored.read(['language'], authoredIndex.stamp).entries[0]!.value;
expectType<'theme' | 'language'>(authoredValue.key);
expectType<readonly string[]>(authoredValue.nested.tags);
expectType<ViewSourceData<{ nested: { tags: string[] } }>>(authoredValue);
// @ts-expect-error source adapter keys retain their literal domain
authored.inspect(['unknown']);
// @ts-expect-error metadata is recursively readonly
authoredIndex.entries[0]!.summary.groups.push('changed');
// @ts-expect-error source values are recursively readonly
authoredValue.nested.tags.push('changed');
// @ts-expect-error nested source values cannot be replaced
authoredValue.nested = { tags: [] };
// @ts-expect-error fixed source identity is readonly
authored.scope = 'other';
const authoredOptions: ViewSourceOptions<number, { title: string }, { content: string }> = { id: 'numbers', scope: 'whole', version: () => '0', keys: () => [0], inspect: (key) => ({ title: String(key) }), read: () => ({ content: 'value' }) };
expectType<SyncViewSource<number, { readonly title: string }, { readonly content: string }>>(createViewSource(authoredOptions));
const optional = createViewSource({ id: 'optional', scope: 'whole', version: () => '0', keys: () => ['key'], inspect: () => undefined, read: () => undefined });
expectType<undefined>(optional.inspect(['key']).entries[0]!.summary);
expectType<undefined>(optional.read(['key'], stamp).entries[0]!.value);
// @ts-expect-error the synchronous adapter cannot accept an asynchronous source version
createViewSource({ ...authoredOptions, version: async () => '0' });
// @ts-expect-error the synchronous adapter cannot accept an asynchronous directory
createViewSource({ ...authoredOptions, keys: async () => [0] });
// @ts-expect-error the synchronous adapter cannot accept asynchronous metadata
createViewSource({ ...authoredOptions, inspect: async () => ({ title: 'async' }) });
// @ts-expect-error the synchronous adapter cannot accept asynchronous bodies
createViewSource({ ...authoredOptions, read: async () => ({ content: 'async' }) });
// @ts-expect-error source content cannot expose callable capabilities
createViewSource({ ...authoredOptions, read: () => ({ run() {} }) });

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
// @ts-expect-error metadata inspection preserves source-specific key types
sources.messages.inspect(['0']);
// @ts-expect-error memory inspection cannot use message indexes
sources.memories.inspect([0]);

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
  async inspect(keys) {
    return skills.inspect(keys);
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
