import { useAppStore, useAppCommands } from '../../state/react';
import { Settings2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { ChatMessages } from './ChatMessages';
import { Composer } from './Composer';
import './conversation.css';
export function ConversationPanel() {
  const messageCount = useAppStore((state) => state.data.messageCount);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const conversation = useAppStore((state) => state.data.conversation);
  const pending = useAppStore((state) => state.data.pending);
  const conversationError = useAppStore((state) => state.data.conversationError);
  const progress = useAppStore((state) => state.data.progress);
  const busy = useAppStore((state) => state.data.busy);
  const config = useAppStore((state) => state.data.config);
  const selectedId = useAppStore((state) => state.selectedId);
  const inspect = useAppStore((state) => state.inspect);
  const draft = useAppStore((state) => state.draft);
  const setDraft = useAppStore((state) => state.setDraft);
  const { submit, reconnectConversation } = useAppCommands();
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
      {conversationError && (
        <div className="notice" role="alert">
          消息同步失败：{conversationError}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void reconnectConversation();
            }}
          >
            重新连接
          </Button>
        </div>
      )}
      <ChatMessages rows={conversation} pending={pending} progress={progress} selectedId={selectedId} onInspect={inspect} />
      <Composer configured={config?.configured ?? false} loaded={Boolean(config)} busy={busy} draft={draft} onDraft={setDraft} onSubmit={submit} />
    </aside>
  );
}
