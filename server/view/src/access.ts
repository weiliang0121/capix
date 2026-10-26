import type { ResourceEndpointActivity } from '@capix/resources';
import type { SourceBindings, SyncSourceBindings, ViewSources } from './source.js';
import type { ViewIndex, ViewPersistence, ViewSelection, ViewSnapshot, ViewState } from './types.js';
import type { View } from './view.js';
import { sourcePorts } from './reading.js';

export interface ViewAccess<Sources extends ViewSources> {
  index(): Promise<ViewIndex<Sources>>;
  capture(index?: ViewIndex<Sources>): Promise<ViewSnapshot<Sources>>;
}
export interface ViewManager<Sources extends ViewSources> {
  index(): ViewIndex<Sources>;
  capture(index?: ViewIndex<Sources>): ViewSnapshot<Sources>;
  apply(selection: ViewSelection<Sources>): ViewState<Sources>;
}

/** A resource adapter supplies the view and its fixed sources; no sibling resource lookup is implied. */
export function openView<Sources extends ViewSources>(view: View<Sources>, sources: SourceBindings<Sources>, activity: ResourceEndpointActivity): ViewAccess<Sources> {
  activity.validate();
  const ports = sourcePorts<Sources>(sources, Object.keys(view.exportState().sources), () => activity.validate());
  return Object.freeze({
    index: () => activity.runAsync('index', { output: (index) => ({ revision: index.basis.viewRevision, members: index.members.length }) }, () => view.index(ports)),
    capture: (index?: ViewIndex<Sources>) => activity.runAsync('capture', { output: (snapshot) => ({ revision: snapshot.basis.viewRevision, members: snapshot.entries.length }) }, () => view.capture(ports, index)),
  });
}

/** Management requires synchronous sources and a host-owned synchronous persistence transaction. */
export function openViewManager<Sources extends ViewSources>(view: View<Sources>, sources: SyncSourceBindings<Sources>, activity: ResourceEndpointActivity, persistence?: ViewPersistence<Sources>): ViewManager<Sources> {
  activity.validate();
  const ports = sourcePorts<Sources>(sources, Object.keys(view.exportState().sources), () => activity.validate());
  const writer = persistence ? Object.freeze({ commit: persistence.commit.bind(persistence) }) : undefined;
  return Object.freeze({
    index: () => activity.runSync('index', { output: (index) => ({ revision: index.basis.viewRevision, members: index.members.length }) }, () => view.indexSync(ports)),
    capture: (index?: ViewIndex<Sources>) => activity.runSync('capture', { output: (snapshot) => ({ revision: snapshot.basis.viewRevision, members: snapshot.entries.length }) }, () => view.captureSync(ports, index)),
    apply: (selection: ViewSelection<Sources>) => activity.runSync('apply', { output: (state) => ({ revision: state.revision, members: state.members.length }) }, () => view.applySync(ports, selection, writer)),
  });
}
