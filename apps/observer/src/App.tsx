import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, BrainCircuit, Circle, Diamond, LoaderCircle, Settings2 } from 'lucide-react';
import { isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import type { ConfigurationResponse, MemoryObservation, Message, ObserverOverview, RuntimeSnapshot } from '@capix-observer/protocol';
import { api, run } from './api/client';
import { updateOverview } from './observation/live';
import { RuntimeExplorer } from './features/explorer/RuntimeExplorer';
import { InspectionDialog, MemoryDialog, type Inspection } from './components/details';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function acceptHistory(text: string): Message[] {
  const value: unknown = JSON.parse(text);
  if (!isArray(value) || value.length > 500) throw new Error('追加历史需要是最多 500 条消息的数组。');
  return value.map((message) => {
    if (!isPlainObject(message) || (message.role !== 'user' && message.role !== 'assistant') || !isString(message.content) || !message.content.trim()) throw new Error('每条消息需要 user / assistant 角色与非空正文。');
    return { role: message.role, content: message.content };
  });
}
export function App() {
  const [config, setConfig] = useState<ConfigurationResponse>();
  const [overview, setOverview] = useState<ObserverOverview>({ messages: [], executions: [] });
  const [messages, setMessages] = useState<readonly Readonly<Message>[]>([]);
  const [memory, setMemory] = useState<MemoryObservation>({ items: [] });
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState('');
  const [history, setHistory] = useState('[]');
  const [budget, setBudget] = useState('32768');
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState('');
  const [pending, setPending] = useState('');
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [inspection, setInspection] = useState<Inspection>();
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const snapshots = useRef(new Map<string, RuntimeSnapshot>());
  const chat = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const autoScroll = useRef(true);
  const sending = useRef(false);
  const inspectionRef = useRef(inspection);
  inspectionRef.current = inspection;
  const refresh = useCallback(async () => {
    const [nextOverview, nextTranscript, nextMemory] = await Promise.all([api.overview(), api.transcript(), api.memory()]);
    setOverview(nextOverview);
    setMessages(nextTranscript.messages);
    setMemory(nextMemory);
    setSelectedId((previous) => previous || nextOverview.executions.at(-1)?.id || '');
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([api.config(), api.overview(), api.transcript(), api.memory()])
      .then(([settings, nextOverview, transcript, nextMemory]) => {
        if (!active) return;
        setConfig(settings);
        setBudget(String(settings.contextBudget));
        setOverview(nextOverview);
        setMessages(transcript.messages);
        setMemory(nextMemory);
        setSelectedId(nextOverview.executions.at(-1)?.id ?? '');
      })
      .catch((error) => {
        if (active) setNotice(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (autoScroll.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight;
  }, [messages, pending, busy, overview]);
  useEffect(() => {
    if (!inspection) return;
    const controller = new AbortController();
    const cached = snapshots.current.get(inspection.executionId);
    setSnapshot(cached);
    setDetailError('');
    if (cached && cached.execution.status !== 'running') {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(!cached);
    api
      .execution(inspection.executionId, controller.signal)
      .then((value) => {
        snapshots.current.set(value.execution.id, value);
        setSnapshot(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setDetailError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [inspection?.executionId]);
  const inspect = useCallback((executionId: string, callId?: string) => {
    setSelectedId(executionId);
    setInspection({ executionId, callId });
    setMemoryOpen(false);
  }, []);
  const submit = async () => {
    if (sending.current || !config?.configured) return;
    if (!draft.trim()) {
      setNotice('请先填写消息。');
      return;
    }
    let added: Message[];
    const contextBudget = Number(budget);
    try {
      if (!Number.isSafeInteger(contextBudget) || contextBudget < 256 || contextBudget > 1000000) throw new Error('容量预算需要是 256–1000000 的整数。');
      added = [...acceptHistory(history), { role: 'user', content: draft }];
    } catch (error) {
      setNotice(errorMessage(error));
      return;
    }
    sending.current = true;
    setBusy(true);
    setRunningId('');
    setPending(draft);
    setNotice('');
    autoScroll.current = true;
    let accepted = false;
    try {
      await run(
        { messages: added, contextBudget },
        (value) => {
          snapshots.current.set(value.execution.id, value);
          setRunningId(value.execution.id);
          setOverview((previous) => updateOverview(previous, value));
          setSelectedId(value.execution.id);
          if (inspectionRef.current?.executionId === value.execution.id) setSnapshot(value);
        },
        () => {
          accepted = true;
          setMessages((previous) => [...previous, ...added]);
          setPending('');
          setDraft('');
          setHistory('[]');
        },
      );
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      if (accepted) {
        try {
          await refresh();
        } catch (error) {
          setNotice(errorMessage(error));
        }
      }
      setBusy(false);
      setPending('');
      sending.current = false;
    }
  };
  const liveAnswer = busy ? overview.executions.find((item) => item.id === runningId)?.response : undefined;
  const showLiveAnswer = liveAnswer && !messages.some((message, index) => index === liveAnswer.index && message.role === 'assistant');
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <Diamond size={18} />
          <strong>CAPiX</strong>
          <span>Observer</span>
        </div>
        <div className="connection">
          <Circle size={6} fill="currentColor" />
          {config ? `${config.model} · ${config.configured ? '已连接' : '待配置'}` : '连接中'}
        </div>
      </header>
      {notice && (
        <div className="app-notice" role="alert">
          <span>{notice}</span>
          <Button variant="ghost" size="sm" onClick={() => setNotice('')}>
            关闭
          </Button>
        </div>
      )}
      <main className="workspace">
        <section className="observer-panel">
          <header className="panel-heading">
            <div>
              <span className="eyebrow">RUNTIME EXPLORER</span>
              <div className="heading-title">
                <h1>运行图谱</h1>
                <Badge variant="secondary">{overview.executions.length} 轮问答</Badge>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setMemoryOpen(true)}>
              <BrainCircuit />
              记忆 <span className="button-count">{memory.items.length}</span>
            </Button>
          </header>
          <RuntimeExplorer overview={overview} selectedId={selectedId} onSelect={setSelectedId} onInspect={inspect} />
        </section>
        <aside className="conversation-panel">
          <header className="panel-heading">
            <div>
              <span className="eyebrow">CONVERSATION</span>
              <div className="heading-title">
                <h2>对话</h2>
                <Badge variant="secondary">{messages.length} 条</Badge>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setSettingsOpen(true)} aria-label="对话设置">
              <Settings2 />
            </Button>
          </header>
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
        </aside>
      </main>
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
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setHistory(
                  JSON.stringify(
                    [
                      { role: 'user', content: '天气怎么样？' },
                      { role: 'assistant', content: '你想查询哪个城市？' },
                    ],
                    null,
                    2,
                  ),
                );
                setDraft('上海');
              }}
            >
              填入澄清样例
            </Button>
          </details>
          <Button onClick={() => setSettingsOpen(false)}>完成</Button>
        </DialogContent>
      </Dialog>
      <MemoryDialog open={memoryOpen} onOpenChange={setMemoryOpen} memory={memory} onInspect={inspect} />
      <InspectionDialog target={inspection} snapshot={snapshot} loading={detailLoading} error={detailError} overview={overview} memory={memory} onClose={() => setInspection(undefined)} onInspect={inspect} />
    </div>
  );
}
