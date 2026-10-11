import type { ConversationResponse } from '../../state/conversation';
import { Button } from '../../components/ui/button';
import { AnswerContent } from './AnswerContent';
import { ConversationProcess } from './ConversationProcess';
import { MessageHeading } from './MessageHeading';

/** One stable assistant region receives both progress and its independently synchronized body. */
export function AssistantResponse({ response, reveal, selectedId, onInspect, onReconnect }: { response: ConversationResponse; reveal: boolean; selectedId: string; onInspect: (id: string) => void; onReconnect: () => Promise<void> }) {
  const { body, process, notice } = response;
  return (
    <article data-conversation-key={response.key} data-response-id={response.queueId} className={`chat-message assistant${body?.executionId === selectedId ? ' current' : ''}`}>
      <MessageHeading label="助手" message={body} onInspect={onInspect} />
      {body && <AnswerContent id={body.key} content={body.message.content} reveal={body.reveal && reveal} />}
      {process && <ConversationProcess process={process} />}
      {notice && (
        <div className="response-notice" role="status" aria-live="polite">
          <p>{notice.message}</p>
          {notice.reconnect && (
            <Button type="button" variant="outline" size="sm" onClick={() => void onReconnect()}>
              重新同步
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
