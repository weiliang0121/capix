import { useAppStore, useAppCommands } from '../../state/react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { ChatMessages } from './ChatMessages';
import { MessageQueue } from './MessageQueue';
import { Composer } from './Composer';
import { ConversationControls } from './ConversationControls';
import { ConversationHistory } from './ConversationHistory';
import { errorMessage } from '../../lib/errors';
import './conversation.css';
export function ConversationPanel() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const currentConversation = useAppStore((state) => state.data.activeConversation);
  const switching = useAppStore((state) => state.data.switchingConversation);
  const canSwitch = useAppStore((state) => state.data.canSwitchConversation);
  const conversationError = useAppStore((state) => state.data.conversationError);
  const setNotice = useAppStore((state) => state.setNotice);
  const messageCount = useAppStore((state) => state.data.messageCount);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const conversation = useAppStore((state) => state.data.conversation);
  const conversationSync = useAppStore((state) => state.data.conversationSync);
  const submissionControl = useAppStore((state) => state.data.submissionControl);
  const queue = useAppStore((state) => state.data.queue);
  const config = useAppStore((state) => state.data.config);
  const selectedId = useAppStore((state) => state.selectedId);
  const inspect = useAppStore((state) => state.inspect);
  const draft = useAppStore((state) => state.draft);
  const fileDraft = useAppStore((state) => state.fileDraft);
  const setFileDraft = useAppStore((state) => state.setFileDraft);
  const setDraft = useAppStore((state) => state.setDraft);
  const focus = useAppStore((state) => state.conversationFocus);
  const { submit, reconnectConversation, reconnectSubmission, cancelSubmission, createConversation } = useAppCommands();
  return (
    <aside className="conversation-panel">
      <header className="panel-heading conversation-heading">
        <div className="conversation-heading-copy">
          <span className="eyebrow">CONVERSATION</span>
          <div className="heading-title">
            <h2>{currentConversation?.title ?? '对话'}</h2>
            <Badge variant="secondary">{messageCount} 条</Badge>
          </div>
        </div>
        <ConversationControls canSwitch={canSwitch} switching={switching} onCreate={() => void createConversation().catch((error) => setNotice(errorMessage(error)))} onHistory={() => setHistoryOpen(true)} onSettings={() => setSettingsOpen(true)} />
      </header>
      {switching && (
        <p className="conversation-navigation-notice" role="status">
          正在打开对话…
        </p>
      )}
      {conversationError && (
        <p className="conversation-navigation-notice" role="alert">
          {conversationError}
        </p>
      )}
      {conversationSync && (
        <div className="notice" role="status">
          {conversationSync.message}{' '}
          {conversationSync.reconnect && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void reconnectConversation();
              }}
            >
              重新连接
            </Button>
          )}
        </div>
      )}
      <ChatMessages key={`messages:${currentConversation?.id ?? 'initial'}`} rows={conversation} focus={focus} selectedId={selectedId} onInspect={inspect} onReconnect={reconnectSubmission} />
      <MessageQueue queue={queue} onCancel={cancelSubmission} />
      <Composer key={`composer:${currentConversation?.id ?? 'initial'}`} disabled={switching || !currentConversation} configured={config?.configured ?? false} loaded={Boolean(config)} draft={draft} current={submissionControl} files={config?.files} fileDraft={fileDraft} onFileDraft={setFileDraft} onDraft={setDraft} onSubmit={submit} onCancel={cancelSubmission} />
      <ConversationHistory open={historyOpen} onOpenChange={setHistoryOpen} />
    </aside>
  );
}
