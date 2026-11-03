import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationSession } from '@capix/client-runtime';
import { SessionHttpTransport } from '@capix/client-http';
import { ConversationApplication, createConversationTrackingStore } from './binding.js';
import { ConversationApp } from './App.js';
import '../styles.css';
import '../components/message.css';
import '../features/conversation/conversation.css';
import './style.css';

const transport = new SessionHttpTransport();
const session = new ConversationSession(transport, { tracking: createConversationTrackingStore() });
const application = new ConversationApplication(session, transport);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConversationApp application={application} />
  </StrictMode>,
);
