import { useLayoutEffect, useRef, useState } from 'react';
import type { ConversationSession } from '@capix/client-runtime';
import { ArrowDown } from 'lucide-react';
import { MessageContent } from '../components/message-content.js';
import { CopyMessageButton } from '../features/conversation/CopyMessageButton.js';

/** Presentation only: a preview never becomes a formal message by string comparison. */
export function ConversationMessages({ session }: { session: ConversationSession['snapshot'] }) {
  const messages = session.transcript?.snapshot?.messages ?? [];
  const submission = session.submission;
  const remote = submission?.remote;
  const preview = submission?.preview?.snapshot;
  const answer = remote?.answer ?? preview?.message;
  const answerLoaded = Boolean(answer && answer.transcriptId === session.transcript?.snapshot?.id && messages[answer.index]?.role === 'assistant');
  const showPreview = Boolean(preview?.text && preview.state !== 'discarded' && !answerLoaded && submission?.preview?.status !== 'failed');
  const pending = submission?.pending && (!remote?.input || messages.length < remote.input.end) ? submission.pending : undefined;
  const container = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const track = () => {
    const node = container.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
    setAway(!pinned.current);
  };
  const latest = () => {
    const node = container.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
    pinned.current = true;
    setAway(false);
  };
  useLayoutEffect(() => {
    if (pinned.current) latest();
    else track();
  }, [messages.length, preview?.text, pending]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (pinned.current) latest();
      else track();
    });
    if (body.current) observer.observe(body.current);
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="conversation-message-region">
      <div className="conversation-message-scroll" ref={container} onScroll={track}>
        <div className="conversation-message-body" ref={body}>
          {!messages.length && !pending && (
            <div className="conversation-empty">
              <h3>从一条消息开始</h3>
              <p>回答会实时显示。右侧可以查看调用过程，以及对话中形成的记忆。</p>
            </div>
          )}
          {messages.map((message, index) => (
            <article className={`conversation-message ${message.role}`} id={`message-${index}`} key={index}>
              <div className="conversation-message-heading">
                <span>
                  {message.role === 'user' ? '你' : '助手'} <small>#{index}</small>
                </span>
                <CopyMessageButton content={message.content} />
              </div>
              <div className="conversation-message-content">
                <MessageContent content={message.content} format={message.role === 'assistant' ? 'markdown' : 'plain'} />
              </div>
            </article>
          ))}
          {pending && (
            <article className="conversation-message user pending">
              <div className="conversation-message-heading">
                <span>
                  你 <small>{remote?.result && !remote.input ? '未形成正式消息' : '等待正式接纳'}</small>
                </span>
                <CopyMessageButton content={pending} />
              </div>
              <div className="conversation-message-content">
                <MessageContent content={pending} />
              </div>
            </article>
          )}
          {showPreview && preview && (
            <article className="conversation-message assistant preview">
              <div className="conversation-message-heading">
                <span>
                  助手 <small>{preview.state === 'committed' ? '正在同步正式消息' : '生成中 · 预览'}</small>
                </span>
              </div>
              <MessageContent content={preview.text} format="markdown" complete={preview.state !== 'streaming'} />
              {submission?.preview?.status === 'interrupted' && <p className="conversation-muted">预览连接中断，正在等待正式结果。</p>}
            </article>
          )}
          {!showPreview && submission && !remote?.result && !answerLoaded && (
            <p className="conversation-waiting" role="status">
              {submission.feedback.status === 'unavailable' ? '提交结果暂不可查询' : submission.feedback.status === 'interrupted' ? '等待接回提交' : '正在处理…'}
            </p>
          )}
        </div>
      </div>
      {away && (
        <button className="conversation-latest" onClick={latest}>
          <ArrowDown size={14} />
          回到最新
        </button>
      )}
    </div>
  );
}
