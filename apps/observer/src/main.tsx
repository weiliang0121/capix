import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClientRuntime } from '@capix/client-runtime';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';
import { App } from './App';
import { createApplication } from './binding/application';
import { createSessionTrackingStore } from './binding/tracking';
import { AppProvider } from './state/react';
import './styles.css';
import './components/message.css';

const conversation = new ConversationHttpTransport();
const runtime = new ClientRuntime({ conversation, transcripts: conversation, observation: new ObservationHttpTransport(), tracking: createSessionTrackingStore() });
const application = createApplication(runtime);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider application={application}>
      <App />
    </AppProvider>
  </StrictMode>,
);
