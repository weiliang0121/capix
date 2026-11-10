import { openView, openViewManager, type View, type SyncViewSource, type ViewSource, type ViewCommit, type SourceStamp } from '@weiliang0121/capix-view';
import type { ResourceEndpointActivity } from '@weiliang0121/capix-resources';

declare function expectType<Value>(value: Value): void;
declare const sources: {
  messages: SyncViewSource<number, { role: 'user' | 'assistant' }, { content: string }>;
  skills: SyncViewSource<string, { title: string }, { text: string }>;
};
declare const view: View<typeof sources>;
declare const activity: ResourceEndpointActivity;
declare const asynchronous: ViewSource<number, { role: 'user' | 'assistant' }, { content: string }>;

expectType<boolean>(view.has({ source: 'messages', key: 0 }));
expectType<boolean>(view.has({ source: 'skills', key: 'translate' }));
for (const member of view.members()) {
  if (member.source === 'messages') expectType<number>(member.key);
  if (member.source === 'skills') expectType<string>(member.key);
}
view.includeSync(sources, [
  { source: 'messages', key: 1 },
  { source: 'skills', key: 'review' },
]);
view.excludeSync([{ source: 'messages', key: 0 }]);

// @ts-expect-error membership lookup preserves each source's key contract
view.has({ source: 'messages', key: '0' });
// @ts-expect-error a source name is not an arbitrary string
view.has({ source: 'unknown', key: 0 });
// @ts-expect-error returned membership is immutable
view.members().push({ source: 'messages', key: 0 });
// @ts-expect-error addition preserves the source-key correlation
view.includeSync(sources, [{ source: 'skills', key: 1 }]);
// @ts-expect-error exclusion preserves the same source-key correlation
view.excludeSync([{ source: 'messages', key: '0' }]);
// @ts-expect-error direct management cannot accept asynchronous inspection or validation
view.includeSync({ ...sources, messages: asynchronous }, [{ source: 'messages', key: 0 }]);

const reader = openView(view, sources, activity);
const manager = openViewManager(view, sources, activity);
expectType<boolean>(reader.has({ source: 'skills', key: 'translate' }));
expectType<boolean>(manager.has({ source: 'messages', key: 0 }));
manager.include([{ source: 'skills', key: 'review' }]);
manager.exclude([{ source: 'messages', key: 1 }]);
for (const member of reader.members()) if (member.source === 'messages') expectType<number>(member.key);
// @ts-expect-error read access cannot add members
reader.include([{ source: 'skills', key: 'translate' }]);
// @ts-expect-error read access cannot remove members
reader.exclude([{ source: 'skills', key: 'translate' }]);
// @ts-expect-error the manager endpoint retains source-specific keys
manager.include([{ source: 'messages', key: '0' }]);
// @ts-expect-error the manager endpoint cannot widen source names
manager.exclude([{ source: 'anything', key: 0 }]);

declare const commit: ViewCommit<typeof sources>;
expectType<SourceStamp | undefined>(commit.checkedSources.messages);
expectType<SourceStamp | undefined>(commit.checkedSources.skills);
// @ts-expect-error partial verification cannot be presented as a complete view basis
commit.basis;
// @ts-expect-error checked source stamps are immutable facts
commit.checkedSources.messages = { id: 'other', scope: 'whole', version: '0' };
