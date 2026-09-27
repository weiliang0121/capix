import { useEffect } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { ArrowDown, ArrowUpRight, Diamond, LoaderCircle } from 'lucide-react';
import type { ConversationMessage } from '../../observation/conversation';
import { MessageContent } from '../../components/message-content';
import { Button } from '../../components/ui/button';
export function ChatMessages({ rows, pending, progress, selectedId, onInspect }: { rows: readonly ConversationMessage[]; pending: string; progress: string; selectedId: string; onInspect: (id: string) => void }) {
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: 'instant', resize: 'instant' });
  useEffect(() => {
    if (pending) void scrollToBottom('instant');
  }, [pending, scrollToBottom]);
  return (
    <div className="conversation-body">
      <div ref={scrollRef} className="conversation-scroll" role="log" aria-label="对话消息" tabIndex={0}>
        <div ref={contentRef} className="conversation-content">
          {!rows.length && !pending && (
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
          {rows.map(({ key, message, index, executionId, round }) => {
            return (
              <article key={key} className={`chat-message ${message.role}${executionId === selectedId ? ' current' : ''}`}>
                <div className="message-heading">
                  <span>
                    {message.role === 'user' ? '你' : '助手'} {index !== undefined && <span className="message-index">[{index}]</span>}
                  </span>
                  {executionId && (
                    <button className="message-location" onClick={() => onInspect(executionId)} aria-label={`查看第 ${round} 轮问答`}>
                      问答 {String(round).padStart(2, '0')}
                      <ArrowUpRight size={12} />
                    </button>
                  )}
                </div>
                <MessageContent content={message.content} markdown={message.role === 'assistant'} />
              </article>
            );
          })}
          {pending && (
            <article className="chat-message user pending">
              <div className="message-heading">发送中</div>
              <MessageContent content={pending} />
            </article>
          )}
          {progress && (
            <p className="chat-progress" role="status">
              <LoaderCircle size={14} className="animate-spin" />
              {progress}
            </p>
          )}
        </div>
      </div>
      {!isAtBottom && (
        <Button className="conversation-latest" variant="secondary" size="sm" onClick={() => void scrollToBottom('instant')}>
          <ArrowDown size={14} />
          回到最新
        </Button>
      )}
    </div>
  );
}
