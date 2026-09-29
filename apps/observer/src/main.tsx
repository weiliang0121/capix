import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix-observer/client-http';
import { App } from './App';
import { createApplication } from './binding/application';
import { AppProvider } from './state/react';
import './styles.css';
import './components/message.css';

const runtime = new ClientRuntime({ conversation: new ConversationHttpTransport(), observation: new ObservationHttpTransport() });
const application = createApplication(runtime);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider application={application}>
      <App />
    </AppProvider>
  </StrictMode>,
);
