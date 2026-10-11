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
  const pendingProcesses = useAppStore((state) => state.data.pendingProcesses);
  const pending = useAppStore((state) => state.data.pending);
  const pendingLabel = useAppStore((state) => state.data.pendingLabel);
  const conversationError = useAppStore((state) => state.data.conversationError);
  const submissionNotice = useAppStore((state) => state.data.submissionNotice);
  const submissionControl = useAppStore((state) => state.data.submissionControl);
  const queue = useAppStore((state) => state.data.queue);
  const progress = useAppStore((state) => state.data.progress);
  const busy = useAppStore((state) => state.data.busy);
  const config = useAppStore((state) => state.data.config);
  const selectedId = useAppStore((state) => state.selectedId);
  const inspect = useAppStore((state) => state.inspect);
  const draft = useAppStore((state) => state.draft);
  const setDraft = useAppStore((state) => state.setDraft);
  const { submit, reconnectConversation, reconnectSubmission, cancelSubmission, cancelAll, clearQueue, pauseQueue, resumeQueue } = useAppCommands();
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
      {submissionNotice && (
        <div className="submission-notice" role="status" aria-live="polite">
          <p>{submissionNotice.message}</p>
          {submissionNotice.input && (
            <div className="submission-input" tabIndex={0} aria-label="本次提交的输入">
              <span>本次提交的输入</span>
              <p>{submissionNotice.input}</p>
            </div>
          )}
          {submissionNotice.reconnect && (
            <div className="submission-notice-actions">
              <Button variant="outline" size="sm" onClick={() => void reconnectSubmission()}>
                重新同步
              </Button>
            </div>
          )}
        </div>
      )}
      <ChatMessages rows={conversation} pendingProcesses={pendingProcesses} pending={pending} pendingLabel={pendingLabel} progress={progress} selectedId={selectedId} onInspect={inspect} />
      <MessageQueue queue={queue} current={submissionControl} onCancel={cancelSubmission} onCancelAll={cancelAll} onClear={clearQueue} onPause={pauseQueue} onResume={resumeQueue} />
      <Composer configured={config?.configured ?? false} loaded={Boolean(config)} queueing={busy || queue.paused || queue.waiting.length > 0} draft={draft} onDraft={setDraft} onSubmit={submit} />
    </aside>
  );
}
