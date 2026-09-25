import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { ClientRuntime, ClientState } from '@capix-observer/client-runtime';
import { connectAppStore } from './store';
import type { AppStore } from './store';

interface Application {
  runtime: ClientRuntime;
  store: AppStore;
}

const ApplicationContext = createContext<Application | undefined>(undefined);

export function AppProvider({ application, children }: { application: Application; children: ReactNode }) {
  useEffect(() => connectAppStore(application.store, application.runtime), [application]);
  return <ApplicationContext.Provider value={application}>{children}</ApplicationContext.Provider>;
}

function useApplication() {
  const application = useContext(ApplicationContext);
  if (!application) throw new Error('AppProvider is required.');
  return application;
}

export function useAppStore<T>(selector: (state: ReturnType<AppStore['getState']>) => T): T {
  return useStore(useApplication().store, selector);
}

export function useClientRuntime(): ClientRuntime {
  return useApplication().runtime;
}

/** Select a stable field/reference; derived objects belong in component memoization. */
export function useClientState<T>(selector: (state: ClientState) => T): T {
  const runtime = useClientRuntime();
  return useSyncExternalStore(runtime.subscribe, () => selector(runtime.getSnapshot()));
}

export function useExecutionSnapshot(id?: string) {
  const runtime = useClientRuntime();
  return useSyncExternalStore(runtime.subscribe, () => (id ? runtime.getExecution(id) : undefined));
}
