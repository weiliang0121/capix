import { useEffect, useRef } from 'react';
import { ArrowUp, ArrowUpRight, Diamond, LoaderCircle, Settings2 } from 'lucide-react';
import { useAppStore, useClientState } from '../state/react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export function ConversationPanel() {
  const messageCount = useClientState((state) => state.messages.length);
  const setSettingsOpen = useAppStore((state) => state.setSettingsOpen);
  const autoScroll = useRef(true);
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
      <ChatMessages autoScroll={autoScroll} />
      <Composer
        onSubmit={() => {
          autoScroll.current = true;
        }}
      />
    </aside>
  );
}

function ChatMessages({ autoScroll }: { autoScroll: { current: boolean } }) {
  const messages = useClientState((state) => state.messages);
  const overview = useClientState((state) => state.overview);
  const pending = useClientState((state) => state.pending);
  const busy = useClientState((state) => state.busy);
  const runningId = useClientState((state) => state.runningId);
  const selectedId = useAppStore((state) => state.selectedId);
  const inspect = useAppStore((state) => state.inspect);
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScroll.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight;
  }, [messages, pending, busy, overview, autoScroll]);
  const liveAnswer = busy ? overview.executions.find((item) => item.id === runningId)?.response : undefined;
  const showLiveAnswer = liveAnswer && !messages.some((message, index) => index === liveAnswer.index && message.role === 'assistant');
  return (
    <div
      ref={chat}
      className="conversation-scroll"
      onScroll={(event) => {
        const el = event.currentTarget;
        autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
      }}
      aria-label="对话消息"
    >
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
      {messages.map((message, index) => {
        const qa = overview.executions.find((item) => item.inputIndex === index || item.response?.index === index);
        return (
          <article key={index} className={`chat-message ${message.role}${qa?.id === selectedId ? ' current' : ''}`}>
            <div className="message-heading">
              <span>
                {message.role === 'user' ? '你' : '助手'} <span className="message-index">[{index}]</span>
              </span>
              {qa && (
                <button className="message-location" onClick={() => inspect(qa.id)} aria-label={`查看第 ${overview.executions.indexOf(qa) + 1} 轮问答`}>
                  问答 {String(overview.executions.indexOf(qa) + 1).padStart(2, '0')}
                  <ArrowUpRight size={12} />
                </button>
              )}
            </div>
            <div className="message-text">{message.content}</div>
          </article>
        );
      })}
      {pending && (
        <article className="chat-message user pending">
          <div className="message-heading">发送中</div>
          <div className="message-text">{pending}</div>
        </article>
      )}
      {showLiveAnswer && (
        <article className="chat-message assistant">
          <div className="message-heading">
            助手 <Badge variant="secondary">回答已完成</Badge>
          </div>
          <div className="message-text">{liveAnswer.content}</div>
        </article>
      )}
      {busy && (
        <p className="chat-progress" role="status">
          <LoaderCircle size={14} className="animate-spin" />
          {liveAnswer ? '正在整理本轮记忆…' : '正在运行，记录持续更新…'}
        </p>
      )}
    </div>
  );
}

function Composer({ onSubmit }: { onSubmit: () => void }) {
  const config = useClientState((state) => state.config);
  const busy = useClientState((state) => state.busy);
  const draft = useAppStore((state) => state.draft);
  const setDraft = useAppStore((state) => state.setDraft);
  const submitDraft = useAppStore((state) => state.submit);
  const composing = useRef(false);
  const submit = () => {
    onSubmit();
    return submitDraft();
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
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
            void submit();
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
