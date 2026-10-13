import type { ConversationResponse } from '../../state/conversation';
import { memo } from 'react';
import { Button } from '../../components/ui/button';
import { AnswerContent } from './AnswerContent';
import { ConversationProcess } from './ConversationProcess';
import { FileResult } from './FileResult';
import { MessageHeading } from './MessageHeading';

/** One stable assistant region receives both progress and its independently synchronized body. */
export const AssistantResponse = memo(function AssistantResponse({ response, reveal, selectedId, onInspect, onReconnect }: { response: ConversationResponse; reveal: boolean; selectedId: string; onInspect: (id: string) => void; onReconnect: () => Promise<void> }) {
  const { body, content, process, notice } = response;
  return (
    <article data-conversation-key={response.key} data-response-id={response.queueId} className={`chat-message assistant${body?.executionId === selectedId ? ' current' : ''}`}>
      <MessageHeading label="助手" message={body} onInspect={onInspect} />
      {content ? <AnswerContent id={content.key} content={content.text} complete={content.complete} reveal={content.reveal && reveal} /> : body && <AnswerContent id={body.key} content={body.message.content} reveal={body.reveal && reveal} />}
      {process && <ConversationProcess process={process} />}
      <FileResult task={response.fileTask} output={response.fileOutput} />
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
});
