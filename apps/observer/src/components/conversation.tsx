import { projectConversation } from '../observation/conversation';
import { useEffect, useMemo, useRef } from 'react';
import { useStickToBottom } from 'use-stick-to-bottom';
import { MessageContent } from './message-content';
import { ArrowDown, ArrowUp, ArrowUpRight, Diamond, LoaderCircle, Settings2 } from 'lucide-react';
import { useAppStore, useClientState } from '../state/react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export function ConversationPanel() {
  const messageCount = useClientState((state) => state.messages.length);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
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
      <ChatMessages />
      <Composer />
    </aside>
  );
}

function ChatMessages() {
  const messages = useClientState((state) => state.messages);
  const overview = useClientState((state) => state.overview);
  const pending = useClientState((state) => state.pending);
  const busy = useClientState((state) => state.busy);
  const runningId = useClientState((state) => state.runningId);
  const selectedId = useAppStore((state) => state.selectedId);
  const inspect = useAppStore((state) => state.inspect);
  const { scrollRef, contentRef, isAtBottom, scrollToBottom } = useStickToBottom({ initial: 'instant', resize: 'instant' });
  useEffect(() => {
    if (pending) void scrollToBottom('instant');
  }, [pending, scrollToBottom]);
  const liveAnswer = busy ? overview.executions.find((item) => item.id === runningId)?.response : undefined;
  const rows = useMemo(() => projectConversation(messages, overview), [messages, overview]);
  return (
    <div className="conversation-body">
      <div ref={scrollRef} className="conversation-scroll" role="log" aria-label="对话消息" tabIndex={0}>
        <div ref={contentRef} className="conversation-content">
          {!messages.length && !pending && (
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
                    <button className="message-location" onClick={() => inspect(executionId)} aria-label={`查看第 ${round} 轮问答`}>
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
          {busy && (
            <p className="chat-progress" role="status">
              <LoaderCircle size={14} className="animate-spin" />
              {liveAnswer ? '正在整理本轮记忆…' : '正在运行，记录持续更新…'}
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

function Composer() {
  const config = useClientState((state) => state.config);
  const busy = useClientState((state) => state.busy);
  const draft = useAppStore((state) => state.draft);
  const setDraft = useAppStore((state) => state.setDraft);
  const submitDraft = useAppStore((state) => state.submit);
  const composing = useRef(false);
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submitDraft();
      }}
    >
      <Textarea
        aria-label="输入消息"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={busy}
        placeholder="输入消息，继续这段对话…"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) {
            event.preventDefault();
            void submitDraft();
          }
        }}
      />
      <div className="composer-bottom">
        <span>{!config?.configured && config ? '请在服务端配置模型 Key' : 'Enter 发送 · Shift + Enter 换行'}</span>
        <Button type="submit" size="icon" disabled={busy || !config?.configured || !draft.trim()} aria-label={busy ? '运行中' : '发送消息'}>
          {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </form>
  );
}

export function SettingsDialog() {
  const config = useClientState((state) => state.config);
  const settingsOpen = useAppStore((state) => state.settingsOpen);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const budget = useAppStore((state) => state.budget);
  const setBudget = useAppStore((state) => state.setBudget);
  const history = useAppStore((state) => state.history);
  const setHistory = useAppStore((state) => state.setHistory);
  const fillExample = useAppStore((state) => state.fillExample);
  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="settings-dialog">
        <DialogHeader>
          <DialogTitle>对话设置</DialogTitle>
          <DialogDescription>执行开始时捕获配置；修改只对下一轮生效。</DialogDescription>
        </DialogHeader>
        <div className="settings-field">
          <label htmlFor="budget">请求容量预算</label>
          <Input id="budget" type="number" min={256} max={1000000} value={budget} onChange={(event) => setBudget(event.target.value)} />
          <p>完整模型请求按 UTF-8 字节估算，包含输出预留。不是模型的上下文窗口大小。</p>
        </div>
        <div className="settings-field">
          <span>模型</span>
          <strong>{config?.model ?? '读取中'}</strong>
          <p>模型与连接信息由服务端提供。</p>
        </div>
        <details className="history-editor">
          <summary>下一轮追加已有消息</summary>
          <p>仅用于接纳原始 user / assistant 消息；不会创建历史执行记录。</p>
          <Textarea aria-label="追加历史 JSON" value={history} onChange={(event) => setHistory(event.target.value)} spellCheck={false} />
          <Button variant="secondary" size="sm" onClick={fillExample}>
            填入澄清样例
          </Button>
        </details>
        <Button onClick={() => setSettingsOpen(false)}>完成</Button>
      </DialogContent>
    </Dialog>
  );
}
