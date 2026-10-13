import { ArrowDown, Diamond } from 'lucide-react';
import { findLast } from 'es-toolkit/compat';
import type { ConversationItem } from '../../state/conversation';
import { MessageContent } from '../../components/message-content';
import { Button } from '../../components/ui/button';
import { AnswerContent } from './AnswerContent';
import { AssistantResponse } from './AssistantResponse';
import { MessageHeading } from './MessageHeading';
import { TextRevealProvider } from '../../presentation/text/react';
import { useConversationScroll } from '../../presentation/conversation/scroll';
import { useConversationReveal } from '../../presentation/conversation/reveal';

interface ChatMessagesProps {
  rows: readonly ConversationItem[];
  focus?: string;
  selectedId: string;
  onInspect: (id: string) => void;
  onReconnect: () => Promise<void>;
}

export function ChatMessages(props: ChatMessagesProps) {
  const messageKeys = props.rows.flatMap((row) => (row.kind === 'message' ? [row.key] : row.kind === 'response' && (row.content || row.body) ? [row.content?.key ?? row.body!.key] : []));
  const pendingKeys = props.rows.flatMap((row) => (row.kind === 'response' && row.content && !row.content.complete ? [row.content.key] : []));
  return (
    <TextRevealProvider keys={messageKeys} pendingKeys={pendingKeys}>
      <ConversationView {...props} />
    </TextRevealProvider>
  );
}

function ConversationView({ rows: source, focus, selectedId, onInspect, onReconnect }: ChatMessagesProps) {
  const { rows, playing } = useConversationReveal(source);
  const response = findLast(rows, (row) => row.kind === 'response');
  const inputOwners = new Map(source.flatMap((row) => (row.kind === 'response' && row.afterInputKey ? [[row.afterInputKey, row.queueId] as const] : [])));
  const { scrollRef, contentRef, reading, latest } = useConversationScroll(rows, response ? { key: response.key, queueId: response.queueId, inputKey: response.afterInputKey } : undefined, focus);
  return (
    <div className="conversation-body">
      <div ref={scrollRef} className="conversation-scroll" role="log" aria-live="off" aria-label="对话消息" tabIndex={0}>
        <div ref={contentRef} className="conversation-content">
          {!rows.length && (
            <div className="chat-empty">
              <div className="empty-orbit">
                <Diamond size={24} />
              </div>
              <h3>从一个问题开始</h3>
              <p>
                看见一次回答如何生成，
                <br />
                理解如何积累。
              </p>
            </div>
          )}
          {rows.map((row) => {
            if (row.kind === 'response') return <AssistantResponse key={row.key} response={row} reveal={(row.content?.key ?? row.body?.key) === playing} selectedId={selectedId} onInspect={onInspect} onReconnect={onReconnect} />;
            if (row.kind === 'pending-input') {
              return (
                <article key={row.key} data-conversation-key={row.key} data-submission-input={row.queueId} className="chat-message user pending">
                  <MessageHeading label={`你 · ${row.label}`} copyContent={row.content} onInspect={onInspect} />
                  <MessageContent content={row.content} />
                </article>
              );
            }
            return (
              <article key={row.key} data-conversation-key={row.key} data-submission-input={inputOwners.get(row.key)} className={`chat-message ${row.message.role}${row.executionId === selectedId ? ' current' : ''}`}>
                <MessageHeading label={row.message.role === 'user' ? '你' : '助手'} message={row} onInspect={onInspect} />
                {row.message.role === 'assistant' ? <AnswerContent id={row.key} content={row.message.content} reveal={row.reveal && row.key === playing} /> : <MessageContent content={row.message.content} />}
              </article>
            );
          })}
        </div>
      </div>
      {reading && (
        <Button className="conversation-latest" variant="secondary" size="sm" onClick={latest}>
          <ArrowDown size={14} />
          回到最新
        </Button>
      )}
    </div>
  );
}
