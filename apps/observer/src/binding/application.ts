import type { ClientRuntime } from '@capix/client-runtime';
import { createAppStore } from '../state/store.js';
import type { AppStore, AppState } from '../state/store.js';
import { searchRounds } from './search.js';
import { createDataProjection } from './data.js';
import { errorMessage } from '../lib/errors.js';
import { submitDraft } from './submit.js';

export function createApplication(runtime: ClientRuntime) {
  const store = createAppStore();
  return {
    store,
    connect: () => connectAppStore(store, runtime),
    commands: {
      submit: () => submitDraft(store, runtime),
      reconnectConversation: () =>
        runtime.initialize().catch((error) => {
          store.getState().setNotice(errorMessage(error));
        }),
      loadExecution: async (id: string, signal?: AbortSignal): Promise<void> => {
        await runtime.loadExecution(id, signal);
      },
      loadTranscript: (id: string) => runtime.loadTranscript(id),
      source: (path: string, signal?: AbortSignal) => runtime.source(path, signal),
    },
  };
}
export type Application = ReturnType<typeof createApplication>;

/** Receive -> interpret -> commit one application update. No React or DOM dependencies. */
export function connectAppStore(store: AppStore, runtime: ClientRuntime): () => void {
  let active = true;
  const project = createDataProjection();
  const receive = () => {
    const observed = runtime.getSnapshot();
    const data = project(observed);
    const change: Partial<AppState> = { data };
    if (data.rounds !== store.getState().data.rounds) change.matches = searchRounds(data.rounds, store.getState().search);
    if (observed.config && observed.config !== store.getState().data.config) change.budget = String(observed.config.contextBudget);
    const selectedId = data.busy && data.runningId ? data.runningId : store.getState().selectedId || data.rounds.at(-1)?.id || '';
    if (selectedId !== store.getState().selectedId) change.selectedId = selectedId;
    store.setState(change);
  };
  const unsubscribe = runtime.subscribe(receive);
  const unsubscribeSearch = store.subscribe((state, previous) => {
    if (state.search !== previous.search) store.setState({ matches: searchRounds(state.data.rounds, state.search) });
  });
  receive();
  const stopObservation = runtime.startObservation();
  void runtime.initialize().catch((error) => {
    if (active) store.getState().setNotice(errorMessage(error));
  });
  return () => {
    active = false;
    stopObservation();
    runtime.stopTranscript();
    unsubscribe();
    unsubscribeSearch();
  };
}
