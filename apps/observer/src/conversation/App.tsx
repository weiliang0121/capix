import { useEffect, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import { ArrowUp, RefreshCw, Square } from 'lucide-react';
import { ConversationApplication, errorText, type ConversationApplicationState } from './binding.js';
import { ConversationMessages } from './messages.js';
import { ConversationInspector } from './Inspector.js';

export function ConversationApp({ application }: { application: ConversationApplication }) {
  const state = useSyncExternalStore(application.subscribe, application.snapshot);
  const { session } = state;
  const [draft, setDraft] = useState('');
  useEffect(() => application.connect(), [application]);
  const submission = session.submission;
  const result = submission?.remote?.result;
  const unresolved = Boolean(submission && (!result || submission.remote?.integrity.status === 'incomplete'));
  const uncertain = unresolved && (submission?.feedback.status === 'interrupted' || submission?.feedback.status === 'unavailable' || submission?.remote?.integrity.status === 'incomplete');
  const failed = result?.status === 'failed' || result?.status === 'rejected' ? result.error.message : undefined;
  const serviceUnavailable = session.info?.admission.status === 'unavailable' ? session.info.admission.error.message : undefined;
  const status = session.status === 'connecting' ? '正在连接' : session.status === 'failed' ? '连接失败' : uncertain ? '结果待确认' : unresolved ? '处理中' : session.info?.admission.status === 'busy' ? '服务忙碌' : session.canSend ? '就绪' : '等待同步';

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!session.canSend || !draft.trim()) return;
    const input = draft;
    setDraft('');
    await application.action(async () => {
      try {
        await application.session.send(input);
      } catch (error) {
        setDraft((current) => current || input);
        throw error;
      }
    });
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }
  return (
    <div className="conversation-page">
      <header className="conversation-topbar">
        <div className="conversation-brand">
          <span className="conversation-logo" aria-hidden="true">
            C
          </span>
          <h1>
            CAPiX <span>对话</span>
          </h1>
        </div>
        <div className="conversation-connection">
          <span>{session.info?.mode === 'demo' ? '离线演示' : session.info?.mode === 'live' ? session.info.model : '连接服务'}</span>
          <span className="conversation-tag" role="status">
            {status}
          </span>
        </div>
      </header>
      <main className="conversation-layout">
        <section className="conversation-chat" aria-label="对话">
          <div className="conversation-section-heading">
            <div>
              <span className="conversation-eyebrow">CONVERSATION</span>
              <h2>
                对话 <span>{session.transcript?.snapshot?.messages.length ?? 0} 条</span>
              </h2>
            </div>
            <span className="conversation-muted">消息与记忆自动保存</span>
          </div>
          {session.info?.mode === 'demo' && <p className="conversation-notice">当前使用离线模型替身，仅演示处理流程。</p>}
          {Boolean(session.error || state.actionError || serviceUnavailable) && (
            <div className="conversation-notice conversation-problem" role="alert">
              {state.actionError || serviceUnavailable || errorText(session.error)} <button onClick={() => void application.action(() => application.session.reconnect())}>重新连接</button>
            </div>
          )}
          {Boolean(session.trackingError) && (
            <div className="conversation-notice" role="status">
              本标签页无法保存接回位置。刷新前请等待当前提交结束。
            </div>
          )}
          {session.canForget && !submission && (
            <div className="conversation-notice" role="status">
              本标签页保存的接回位置不属于当前对话。
              <button onClick={() => void application.action(() => application.session.forget())}>清理旧跟踪位置</button>
            </div>
          )}
          {session.transcript?.sync.status === 'failed' && (
            <div className="conversation-notice conversation-problem" role="alert">
              消息同步已停止，当前显示的是已接收内容。<button onClick={() => void application.action(() => application.session.reconnect())}>重新同步</button>
            </div>
          )}
          <ConversationRecoveryNotice application={application} state={state} />
          <ConversationMessages session={session} />
          {failed && (
            <p className="conversation-notice conversation-problem" role="status">
              本次处理失败：{failed}。已经保存的消息仍然保留。
            </p>
          )}
          {result?.status === 'cancelled' && (
            <p className="conversation-notice" role="status">
              本次调用已停止，已经保存的消息仍然保留。
            </p>
          )}
          {uncertain && (
            <div className="conversation-notice" role="status">
              <p>尚未确认这次提交的最终结果。重新连接只查询已有处理，不会再次发送。</p>
              <div className="conversation-actions">
                <button onClick={() => void application.action(() => application.session.reconnect())}>
                  <RefreshCw size={14} />
                  重新接回
                </button>
                {session.canForget && <button onClick={() => void application.action(() => application.session.forget())}>结束本地跟踪</button>}
              </div>
              <small>结束跟踪不会取消服务端处理，也不能据此判断是否成功。</small>
            </div>
          )}
          <form className="conversation-composer" onSubmit={(event) => void submit(event)}>
            <label className="conversation-sr-only" htmlFor="conversation-input">
              消息
            </label>
            <textarea id="conversation-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={keyDown} placeholder="输入消息，继续这段对话…" rows={3} maxLength={128_000} />
            <div className="conversation-composer-footer">
              <span>{unresolved ? (submission?.cancellation ? '已请求停止，等待实际结束' : '正在处理本次提交') : 'Enter 发送 · Shift + Enter 换行'}</span>
              {unresolved && submission?.feedback.status !== 'unavailable' ? (
                <button type="button" className="conversation-send" disabled={Boolean(submission?.cancellation && submission.cancellation.status !== 'uncertain')} onClick={() => void application.action(() => application.session.cancel())}>
                  <Square size={14} />
                  停止
                </button>
              ) : (
                <button className="conversation-send" disabled={!session.canSend || !draft.trim()}>
                  <ArrowUp size={16} />
                  发送
                </button>
              )}
            </div>
          </form>
        </section>
        <ConversationInspector application={application} state={state} />
      </main>
    </div>
  );
}

export function ConversationRecoveryNotice({ application, state }: { application: ConversationApplication; state: ConversationApplicationState }) {
  return (
    <>
      {state.recoveries?.length ? (
        <div className="conversation-notice" role="status">
          <p>发现上次未完成的处理。可以依据已保存结果继续，不会重新发送原模型请求。</p>
          {state.recoveries.map((item) => (
            <div className="conversation-actions" key={item.contextId}>
              <small title={item.contextId}>
                {item.contextId.slice(0, 8)} · {item.available ? '可继续' : item.reason || '当前不可继续'}
              </small>
              {item.available && (
                <button disabled={!state.session.canSend} onClick={() => void application.action(() => application.session.resume(item.contextId))}>
                  继续上次处理
                </button>
              )}
            </div>
          ))}
          {state.session.canForget && <small>请先结束旧提交的本地跟踪，再选择继续。</small>}
        </div>
      ) : null}
      {state.recoveryError && (
        <p className="conversation-notice conversation-problem" role="status">
          无法读取恢复依据：{state.recoveryError} <button onClick={() => void application.refreshRecoveries()}>重新查询</button>
        </p>
      )}
    </>
  );
}
