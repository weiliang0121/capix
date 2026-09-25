import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { ObserverHttpTransport } from '@capix-observer/client-http';
import { App } from './App';
import { createAppStore } from './state/store';
import { AppProvider } from './state/react';
import './styles.css';

const runtime = new ClientRuntime(new ObserverHttpTransport());
const application = { runtime, store: createAppStore(runtime) };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider application={application}>
      <App />
    </AppProvider>
  </StrictMode>,
);
