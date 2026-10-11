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
      reconnectSubmission: () =>
        runtime.reconnectSubmission().catch((error) => {
          store.getState().setNotice(errorMessage(error));
        }),
      cancelSubmission: (id: string) =>
        runtime.cancelSubmission(id).catch((error) => {
          store.getState().setNotice(errorMessage(error));
        }),
      cancelAll: () =>
        runtime.cancelAll().catch((error) => {
          store.getState().setNotice(errorMessage(error));
        }),
      clearQueue: () => runtime.clearQueue(),
      pauseQueue: () => runtime.pauseQueue(),
      resumeQueue: () => {
        try {
          runtime.resumeQueue();
        } catch (error) {
          store.getState().setNotice(errorMessage(error));
        }
      },
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

/** Project the latest published runtime state once per browser frame. */
export function connectAppStore(store: AppStore, runtime: ClientRuntime): () => void {
  let active = true;
  let frame: number | undefined;
  let projectionNotice: string | undefined;
  const project = createDataProjection();
  const receive = () => {
    if (!active) return;
    let change: Partial<AppState>;
    try {
      const observed = runtime.getSnapshot();
      const data = project(observed);
      const current = store.getState();
      change = { data };
      if (data.rounds !== current.data.rounds) change.matches = searchRounds(data.rounds, current.search);
      if (observed.config && observed.config !== current.data.config) change.budget = String(observed.config.contextBudget);
      const selectedId = data.busy && data.runningId ? data.runningId : current.selectedId || data.rounds.at(-1)?.id || '';
      if (selectedId !== current.selectedId) change.selectedId = selectedId;
      if (projectionNotice && current.notice === projectionNotice) change.notice = '';
      projectionNotice = undefined;
    } catch (error) {
      projectionNotice = `界面数据更新失败：${errorMessage(error)}`;
      store.getState().setNotice(projectionNotice);
      return;
    }
    store.setState(change);
  };
  const schedule = () => {
    if (!active || frame !== undefined) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      receive();
    });
  };
  const unsubscribe = runtime.subscribe(schedule);
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
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    stopObservation();
    runtime.stopTranscript();
    unsubscribe();
    unsubscribeSearch();
  };
}
