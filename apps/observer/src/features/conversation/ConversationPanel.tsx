import { useAppStore, useAppCommands } from '../../state/react';
import { Settings2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { ChatMessages } from './ChatMessages';
import { MessageQueue } from './MessageQueue';
import { Composer } from './Composer';
import './conversation.css';
export function ConversationPanel() {
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
  const { submit, reconnectConversation, reconnectSubmission, cancelSubmission } = useAppCommands();
  return (
    <aside className="conversation-panel">
      <header className="panel-heading">
        <div>
          <span className="eyebrow">CONVERSATION</span>
          <div className="heading-title">
            <h2>对话</h2>
            <Badge variant="secondary">{messageCount} 条</Badge>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label="对话设置">
          <Settings2 />
        </Button>
      </header>
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
      <ChatMessages rows={conversation} focus={focus} selectedId={selectedId} onInspect={inspect} onReconnect={reconnectSubmission} />
      <MessageQueue queue={queue} onCancel={cancelSubmission} />
      <Composer configured={config?.configured ?? false} loaded={Boolean(config)} draft={draft} current={submissionControl} files={config?.files} fileDraft={fileDraft} onFileDraft={setFileDraft} onDraft={setDraft} onSubmit={submit} onCancel={cancelSubmission} />
    </aside>
  );
}
