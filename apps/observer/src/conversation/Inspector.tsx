import { useMemo, useState, type KeyboardEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { ConversationApplication, type ConversationApplicationState } from './binding.js';
import { ConversationCalls, statusLabel } from './calls.js';

export function ConversationInspector({ application, state }: { application: ConversationApplication; state: ConversationApplicationState }) {
  const [tab, setTab] = useState<'calls' | 'memories' | 'view'>('calls');
  const inspection = state.inspection;
  const messages = state.session.transcript?.snapshot?.messages ?? [];
  const activeMemories = new Set(inspection?.view.members.filter((item) => item.source === 'memories').map((item) => item.key));
  const memories = useMemo(() => new Map(inspection?.memories.items.map((memory) => [memory.id, memory])), [inspection]);
  function moveTab(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = ['calls', 'memories', 'view'] as const;
    const index = tabs.indexOf(tab);
    const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : undefined;
    if (!next) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(`${next}-tab`)?.focus();
  }
  return (
    <aside className="conversation-inspector" aria-label="对话检查">
      <div className="conversation-section-heading">
        <div>
          <span className="conversation-eyebrow">INSPECT</span>
          <h2>查看处理</h2>
        </div>
        <button className="conversation-refresh" disabled={state.inspectionStatus === 'loading' || !state.session.info} onClick={() => void application.refresh()} aria-label="刷新检查内容">
          <RefreshCw size={15} />
          刷新
        </button>
      </div>
      <div className="conversation-tabs" role="tablist" aria-label="检查内容" onKeyDown={moveTab}>
        <button role="tab" id="calls-tab" aria-controls="calls-panel" aria-selected={tab === 'calls'} tabIndex={tab === 'calls' ? 0 : -1} onClick={() => setTab('calls')}>
          调用 {inspection?.recording.calls.length ?? 0}
        </button>
        <button role="tab" id="memories-tab" aria-controls="memories-panel" aria-selected={tab === 'memories'} tabIndex={tab === 'memories' ? 0 : -1} onClick={() => setTab('memories')}>
          记忆 {inspection?.memories.items.length ?? 0}
        </button>
        <button role="tab" id="view-tab" aria-controls="view-panel" aria-selected={tab === 'view'} tabIndex={tab === 'view' ? 0 : -1} onClick={() => setTab('view')}>
          活跃视图 {inspection?.view.members.length ?? 0}
        </button>
      </div>
      <div className="conversation-inspector-body" role="tabpanel" id={`${tab}-panel`} aria-labelledby={`${tab}-tab`}>
        {state.inspectionStatus === 'loading' && (
          <p className="conversation-muted" role="status">
            正在读取检查内容…
          </p>
        )}
        {state.inspectionError && (
          <p className="conversation-problem" role="alert">
            {state.inspectionError}
          </p>
        )}
        {tab === 'calls' && (
          <>
            <ConversationRecordingControls application={application} state={state} />
            <p className="conversation-caption">仅展示主动采集的调用。运行中可手动刷新，完成后自动更新。</p>
            {inspection?.recording.integrity === 'incomplete' && <p className="conversation-notice conversation-problem">记录来源不完整，以下内容可能缺失；对话结果独立判断。</p>}
            {inspection && !inspection.recording.calls.length && <p className="conversation-muted">{inspection.recording.status === 'idle' ? '尚未开启记录。对话、消息保存和恢复照常工作。' : '这次采集还没有调用记录。'}</p>}
            <div className="conversation-call-list">
              {inspection?.recording.calls
                .slice()
                .reverse()
                .map((call) => (
                  <button className={`conversation-call-summary ${state.selectedCall === call.id ? 'selected' : ''}`} key={call.id} disabled={Boolean(state.recordingPending)} onClick={() => void application.selectCall(call.id)}>
                    <span className="conversation-call-summary-top">
                      <span>{call.startedAt ? new Date(call.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '开始时间未知'}</span>
                      <span className="conversation-tag">{statusLabel(call.status)}</span>
                    </span>
                    <strong>{call.input ? messages[call.input.index]?.content || `消息 #${call.input.index}` : call.name || '本次场景调用'}</strong>
                    {call.answer && <small>已保存回答 #{call.answer.index}</small>}
                  </button>
                ))}
            </div>
            {Boolean(inspection?.recording.omitted) && <p className="conversation-muted">只列出最近的调用；另有 {inspection!.recording.omitted} 次未显示。</p>}
            {state.detailStatus === 'loading' && (
              <p role="status" className="conversation-muted">
                正在读取调用详情…
              </p>
            )}
            {state.detailError && (
              <p role="alert" className="conversation-problem">
                {state.detailError}
              </p>
            )}
            {state.detail && <ConversationCalls detail={state.detail} />}
          </>
        )}
        {tab === 'memories' && inspection && (
          <>
            <p className="conversation-caption">记忆序号 {inspection.memories.sequence} · 显示当前实体，包括已退出活跃视图的记忆。</p>
            {!inspection.memories.items.length && <p className="conversation-muted">还没有形成正式记忆。</p>}
            {inspection.memories.items.map((memory) => (
              <article className="conversation-inspection-card" key={memory.id}>
                <div className="conversation-card-heading">
                  <h3>{memory.topic}</h3>
                  <span className="conversation-tag">{activeMemories.has(memory.id) ? '活跃' : '已退出视图'}</span>
                </div>
                <p className="conversation-memory-content">{memory.content}</p>
                <div className="conversation-source-links">
                  <span>来源</span>
                  {memory.sourceIndexes.map((index) => (
                    <a href={`#message-${index}`} key={index}>
                      消息 #{index}
                    </a>
                  ))}
                </div>
                <details>
                  <summary>身份与结果来源</summary>
                  <pre>{JSON.stringify({ id: memory.id, sourceResults: memory.sourceResults ?? [] }, null, 2)}</pre>
                </details>
              </article>
            ))}
          </>
        )}
        {tab === 'view' && inspection && (
          <>
            <p className="conversation-caption">视图版本 {inspection.view.revision} · 当前成员决定下一次材料读取的范围。退出视图不会删除原始内容。</p>
            <details className="conversation-inspection-card">
              <summary>两个固定来源</summary>
              <pre>{JSON.stringify(inspection.view.sources, null, 2)}</pre>
            </details>
            {!inspection.view.members.length && <p className="conversation-muted">当前活跃视图为空。</p>}
            <ol className="conversation-view-members">
              {inspection.view.members.map((member, index) => {
                const memory = member.source === 'memories' ? memories.get(member.key) : undefined;
                return (
                  <li key={`${member.source}:${member.key}`}>
                    <span className="conversation-member-position">{index + 1}</span>
                    <div>
                      {member.source === 'messages' ? (
                        <>
                          <a href={`#message-${member.key}`}>消息 #{member.key}</a>
                          <p>{messages[member.key]?.content || '消息尚未同步'}</p>
                        </>
                      ) : (
                        <>
                          <span>记忆 · {memory?.topic || member.key}</span>
                          <p>{memory?.content || '记忆内容尚未取得'}</p>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </div>
    </aside>
  );
}

export function ConversationRecordingControls({ application, state }: { application: ConversationApplication; state: ConversationApplicationState }) {
  const transport = application.transport;
  if (!transport.startRecording || !transport.stopRecording || !transport.clearRecording) return null;
  const recording = state.recording;
  const pending = state.recordingPending;
  const unavailable = Boolean(pending) || state.session.status !== 'ready';
  return (
    <div className="conversation-recording-controls">
      <div className="conversation-actions">
        <button disabled={unavailable || recording?.status !== 'idle'} onClick={() => void application.changeRecording('start')}>
          {pending === 'start' ? '正在开启…' : '开始记录'}
        </button>
        <button disabled={unavailable || recording?.status !== 'recording'} onClick={() => void application.changeRecording('stop')}>
          {pending === 'stop' ? '正在停止…' : '停止记录'}
        </button>
        <button disabled={unavailable || recording?.status !== 'stopped'} onClick={() => void application.changeRecording('clear')}>
          {pending === 'clear' ? '正在清空…' : '清空记录'}
        </button>
      </div>
      <p className="conversation-caption" role="status">
        {!recording ? '读取记录状态后可操作。' : recording.status === 'idle' ? '默认不记录。开启后，从下一次处理开始采集。' : recording.status === 'recording' ? '记录已开启。停止不会中断对话。' : recording.status === 'stopping' ? '正在等待已纳入的调用收尾，不再采集新调用。' : '记录已停止，可继续查看；清空后可以开始新的采集。'}
      </p>
      {state.recordingError && (
        <p className="conversation-problem" role="alert">
          记录操作未确认：{state.recordingError}。请刷新核对当前状态。
        </p>
      )}
    </div>
  );
}
