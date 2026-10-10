import { createContext, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useStore } from 'zustand';
import type { Application } from '../binding/application';
import type { AppStore } from './store';

const ApplicationContext = createContext<Application | undefined>(undefined);

export function AppProvider({ application, children }: { application: Application; children: ReactNode }) {
  useEffect(() => application.connect(), [application]);
  return <ApplicationContext.Provider value={application}>{children}</ApplicationContext.Provider>;
}

function useApplication() {
  const application = useContext(ApplicationContext);
  if (!application) throw new Error('AppProvider is required.');
  return application;
}

export function useAppStore<SelectedState>(selector: (state: ReturnType<AppStore['getState']>) => SelectedState): SelectedState {
  return useStore(useApplication().store, selector);
}

/** Application commands hide transport and runtime from feature components. */
export function useAppCommands() {
  return useApplication().commands;
}
