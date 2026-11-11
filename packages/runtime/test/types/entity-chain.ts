import { MemoryViewSource, Memories } from '@weiliang0121/capix-memory';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { defineNode, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { View, createViewSource, openView, type ViewSourceData } from '@weiliang0121/capix-view';

function businessSource<Value>(value: Value & ViewSourceData<Value>) {
  return createViewSource<string, { label: string }, Value>({ id: 'business', scope: 'selected', version: () => '0', keys: () => ['selected'], inspect: (_key: string) => ({ label: 'business' }), read: (_key: string) => value });
}
const tasks = businessSource({ priority: 1, details: { note: 'original' } });
const entries = createViewSource({ id: 'entries', scope: 'whole', version: () => '0', keys: () => [0], inspect: (_key: number) => ({ label: 'entry' }), read: (_key: number) => ({ text: 'business entry', tags: ['local'] }) });
const memories = new Memories<{ category: string }>();
const sources = { tasks, entries, memories: new MemoryViewSource(memories) };
const view = new View<typeof sources>({
  revision: 0,
  sources: { tasks, entries, memories: { id: memories.id, scope: 'whole' } },
  members: [
    { source: 'tasks', key: 'selected' },
    { source: 'entries', key: 0 },
  ],
});
const read = new ResourceOffer({ expose: (origin: { view: typeof view; sources: typeof sources }, activity) => openView(origin.view, origin.sources, activity) });
const resources = new Resources().register(new Resource({ view, sources }), read);
const node = defineNode<null, string>()({
  deps: { materials: read.request() },
  async run(work) {
    const snapshot = await work.resources.materials.capture();
    for (const entry of snapshot.entries) {
      if (entry.source === 'tasks') {
        const key: string = entry.key;
        const priority: number = entry.value.priority;
        // @ts-expect-error generic business values stay deeply readonly through resource and Node
        entry.value.details.note = 'mutated';
        // @ts-expect-error business source values do not acquire message fields
        entry.value.role;
        void [key, priority];
      }
      if (entry.source === 'entries') {
        const key: number = entry.key;
        const text: string = entry.value.text;
        // @ts-expect-error append-only business arrays remain readonly material
        entry.value.tags.push('mutated');
        void [key, text];
      }
      if (entry.source === 'memories') {
        const category: string | undefined = entry.value.value.metadata?.category;
        // @ts-expect-error memory metadata keeps its own inferred schema
        entry.value.value.metadata?.note;
        void category;
      }
    }
    return 'read';
  },
});
const scene = new Scene<null, string>({ run: (work) => work.children.invoke(node, null) }).add(node);
const result: Promise<string> = new Runner(scene, resources).build().run(null);
// @ts-expect-error the source slot fixes the member key type
view.includeSync(sources, [{ source: 'entries', key: '0' }]);
// @ts-expect-error only registered source names are valid
view.includeSync(sources, [{ source: 'messages', key: 0 }]);
// @ts-expect-error generic adapter preserves its own key type
entries.read(['0'], entries.index().stamp);
// @ts-expect-error read resources cannot change membership
resources.bind({ read: read.request() }).open().endpoints.read.apply({ members: [] });
void result;
