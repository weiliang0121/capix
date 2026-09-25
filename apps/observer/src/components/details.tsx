import type { Inspection } from '../state/store';
import { useEffect, useState } from 'react';
import { isPlainObject, isString } from 'es-toolkit/predicate';
import { isArray } from 'es-toolkit/compat';
import { ArrowUpRight, ChevronLeft, FileCode2 } from 'lucide-react';
import type { MemoryObservation, MemoryRecord, ObserverOverview, RuntimeSnapshot } from '@capix-observer/protocol';
import type { ClientRuntime } from '@capix-observer/client-runtime';
import { projectExecution } from '../observation/project';
import type { CallSpan, Trace } from '../observation/types';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';

const statusLabels: Record<string, string> = { running: '运行中', passed: '完成', succeeded: '完成', failed: '失败' };
export function Status({ value }: { value: string }) {
  return (
    <Badge variant="secondary" className={`status-tag status-${value}`}>
      {statusLabels[value] ?? value}
    </Badge>
  );
}
export function duration(value: number | undefined) {
  return value === undefined ? '进行中' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
export function DataBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="data-block">
      <h3>{title}</h3>
      <pre>{value === undefined ? '尚无记录' : JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}
function TextBlock({ title, content }: { title: string; content: string }) {
  return (
    <section className="text-block">
      <h3>{title}</h3>
      <p>{content}</p>
    </section>
  );
}
function ChangeCard({ record, onInspect }: { record: MemoryRecord; onInspect?: (id: string, call?: string) => void }) {
  return (
    <Card className="memory-card">
      <CardHeader>
        <div className="card-meta">
          <Badge variant="secondary">{record.value.action === 'create' ? '新建' : '更新'}</Badge>
          <span>{record.memoryId.slice(0, 8)}</span>
        </div>
        <CardTitle>{record.value.result.topic}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="change-note">{record.value.change}</p>
        <p className="memory-content">{record.value.result.content}</p>
        <details>
          <summary>依据与记录</summary>
          <p>本次依据：{record.value.sourceIndexes.map((index) => `[${index}]`).join(' ')}</p>
          <p>完整依据：{record.value.result.sourceIndexes.map((index) => `[${index}]`).join(' ')}</p>
          <DataBlock title="记录关联" value={{ memoryId: record.memoryId, recordId: record.id, executionId: record.executionId, operationId: record.operationId }} />
        </details>
        {onInspect && (
          <Button variant="ghost" size="sm" onClick={() => onInspect(record.executionId, record.operationId)}>
            查看产生这次变化的操作 <ArrowUpRight />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
export function MemoryDialog({ open, onOpenChange, memory, onInspect }: { open: boolean; onOpenChange: (open: boolean) => void; memory: MemoryObservation; onInspect: (id: string, call?: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="inspector-dialog">
        <DialogHeader>
          <DialogTitle>当前记忆</DialogTitle>
          <DialogDescription>{memory.items.length} 个当前理解 · 原文依据与每轮变化保留在各记忆下</DialogDescription>
        </DialogHeader>
        <div className="dialog-scroll">
          <div className="memory-grid">
            {memory.items.map((item) => (
              <Card key={item.id} className="memory-card">
                <CardHeader>
                  <div className="card-meta">
                    <Badge variant="secondary">当前理解</Badge>
                    <span>{item.records.length} 次变化</span>
                  </div>
                  <CardTitle>{item.topic}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="memory-content">{item.content}</p>
                  <details>
                    <summary>原文依据 · {item.sources.length} 条</summary>
                    {item.sources.map((source) => (
                      <blockquote key={source.index}>
                        <span>
                          [{source.index}] {source.message.role === 'user' ? '用户' : '助手'}
                        </span>
                        {source.message.content}
                      </blockquote>
                    ))}
                  </details>
                  <details>
                    <summary>变化记录 · {item.records.length} 条</summary>
                    {[...item.records].reverse().map((record) => (
                      <ChangeCard key={record.id} record={record} onInspect={onInspect} />
                    ))}
                  </details>
                </CardContent>
              </Card>
            ))}
          </div>
          {!memory.items.length && <p className="empty-note">还没有记忆。完成交流后，可以在这里查看形成的理解。</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
function CallChildren({ trace, id, inspect }: { trace: Trace; id: string; inspect: (id: string, call?: string) => void }) {
  const children = trace.callSequence.calls.filter((call) => call.parentId === id);
  return (
    <div className="child-calls">
      {children.map((call) => (
        <Button key={call.id} variant="outline" className="child-call" onClick={() => inspect(trace.id, call.id)}>
          <span>
            {call.recordType === 'attempt' ? '意图' : '操作'} · {call.label}
          </span>
          <span className="inline-meta">
            <Status value={call.status} />
            {duration(call.durationMs)}
            <ArrowUpRight />
          </span>
        </Button>
      ))}
    </div>
  );
}
function Source({ call, runtime }: { call: CallSpan; runtime: ClientRuntime }) {
  const [text, setText] = useState('读取源码…');
  const path = call.source.split(' · ')[0]!;
  useEffect(() => {
    const controller = new AbortController();
    setText('读取源码…');
    runtime
      .source(path, controller.signal)
      .then((source) => setText(source.content))
      .catch((error: Error) => {
        if (!controller.signal.aborted) setText(error.message);
      });
    return () => controller.abort();
  }, [path, runtime]);
  return (
    <section className="data-block">
      <h3>
        <FileCode2 size={16} />
        {call.source}
      </h3>
      <p className="subtle">当前工作区源码，不是执行时的代码快照。</p>
      <pre>
        {text
          .split('\n')
          .map((line, index) => `${String(index + 1).padStart(3)}  ${line}`)
          .join('\n')}
      </pre>
    </section>
  );
}
function MemoryAtCall({ trace, call, memory }: { trace: Trace; call?: CallSpan; memory: MemoryObservation }) {
  const owner = call?.recordType === 'attempt' ? trace.facts.operations.find((operation) => operation.id === call.parentId) : call?.recordType === 'operation' ? trace.facts.operations.find((operation) => operation.id === call.id) : trace.facts.operations.find((operation) => operation.operation === 'selection');
  const input = isPlainObject(owner?.value.input) ? owner.value.input : {};
  const incoming = isArray(input.memories) ? input.memories.filter(isPlainObject) : [];
  const changes = memory.items.flatMap((item) => item.records).filter((record) => record.executionId === trace.id && (!call || call.recordType === 'execution' || record.operationId === owner?.id));
  return (
    <div className="detail-grid">
      <section>
        <h3 className="section-title">本次可见的记忆</h3>
        <p className="subtle">当时的操作输入快照；传入不等于模型采用。</p>
        <div className="memory-grid single">
          {incoming.map((item, index) => (
            <Card className="memory-card" key={isString(item.id) ? item.id : index}>
              <CardHeader>
                <CardTitle>{String(item.topic ?? '')}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="memory-content">{String(item.content ?? '')}</p>
                <p className="subtle">原文依据：{isArray(item.sourceIndexes) ? item.sourceIndexes.map((source) => `[${source}]`).join(' ') : ''}</p>
              </CardContent>
            </Card>
          ))}
        </div>
        {!incoming.length && <p className="empty-note">没有传入记忆。</p>}
      </section>
      <section>
        <h3 className="section-title">本次已登记的变化</h3>
        <div className="memory-grid single">
          {changes.map((record) => (
            <ChangeCard key={record.id} record={record} />
          ))}
        </div>
        {!changes.length && <p className="empty-note">没有已登记的变化。可在提取调用中查看是否返回空结果或尚未完成。</p>}
      </section>
    </div>
  );
}
export function InspectionDialog({ runtime, target, snapshot, loading, error, overview, memory, onClose, onInspect }: { runtime: ClientRuntime; target?: Inspection; snapshot?: RuntimeSnapshot; loading: boolean; error: string; overview: ObserverOverview; memory: MemoryObservation; onClose: () => void; onInspect: (id: string, call?: string) => void }) {
  const [tab, setTab] = useState('overview');
  useEffect(() => setTab('overview'), [target?.executionId, target?.callId]);
  const trace = snapshot ? projectExecution(snapshot) : undefined;
  const call = trace?.callSequence.calls.find((item) => item.id === target?.callId);
  const qa = overview.executions.find((item) => item.id === target?.executionId);
  const number = overview.executions.findIndex((item) => item.id === target?.executionId) + 1;
  const input = trace && isPlainObject(trace.facts.execution.value.input) ? trace.facts.execution.value.input : {};
  const response = qa?.response?.content ?? trace?.nodes.find((node) => node.operation === 'answer' && node.status === 'passed')?.output;
  const answer = isString(response) ? response : isPlainObject(response) && isString(response.content) ? response.content : '本轮尚无已记录的回答。';
  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="inspector-dialog">
        <DialogHeader>
          <div className="eyebrow">
            问答 {String(number).padStart(2, '0')} {call ? ` / ${call.recordType === 'execution' ? '执行' : call.recordType === 'operation' ? '操作' : '意图'}` : ''}
          </div>
          <DialogTitle>{call?.label ?? '这一轮交流'}</DialogTitle>
          <DialogDescription asChild>
            <div className="inline-meta">
              {trace ? (
                <>
                  <Status value={call?.status ?? trace.status} />
                  <span>
                    {duration(call ? call.durationMs : qa?.durationMs)} · {new Date(trace.startedAt).toLocaleString()}
                  </span>
                </>
              ) : (
                '读取当前执行记录'
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        {loading && (
          <p className="empty-note" role="status">
            读取记录…
          </p>
        )}
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {trace && (
          <>
            <div className="inspector-meta">
              {call && (
                <Button variant="ghost" size="sm" onClick={() => onInspect(trace.id)}>
                  <ChevronLeft />
                  返回问答
                </Button>
              )}
              <code>记录 {call?.id ?? trace.id}</code>
            </div>
            <Tabs value={tab} onValueChange={setTab} className="inspector-tabs">
              <TabsList>
                <TabsTrigger value="overview">{call ? '输入 / 输出' : '交流 / 调用'}</TabsTrigger>
                {call && <TabsTrigger value="process">内部过程</TabsTrigger>}
                <TabsTrigger value="context">上下文</TabsTrigger>
                <TabsTrigger value="memory">记忆</TabsTrigger>
                {call && <TabsTrigger value="source">执行源码</TabsTrigger>}
              </TabsList>
              <div className="dialog-scroll">
                <TabsContent value="overview">
                  {call ? (
                    <>
                      <div className="detail-stats">
                        <span>开始 +{duration(call.offsetMs)}</span>
                        <span>本地执行 {Math.max(0, ...call.processes.map((process) => process.round))} 轮</span>
                        <span>调用目标 {call.target ?? call.callee}</span>
                      </div>
                      <div className="detail-grid">
                        <DataBlock title="输入" value={call.input} />
                        <DataBlock title={call.error ? '失败原因' : '最终结果'} value={call.error ?? call.output} />
                      </div>
                      {call.parentId && (
                        <Button variant="ghost" size="sm" onClick={() => onInspect(trace.id, call.parentId)}>
                          查看父调用 <ArrowUpRight />
                        </Button>
                      )}
                      <CallChildren trace={trace} id={call.id} inspect={onInspect} />
                    </>
                  ) : (
                    <>
                      <div className="detail-grid">
                        <TextBlock title={`用户 · [${qa?.inputIndex ?? '—'}]`} content={String(input.content ?? '')} />
                        <TextBlock title={`助手${qa?.response?.index === undefined ? '' : ` · [${qa.response.index}]`}`} content={answer} />
                      </div>
                      {trace.error && <DataBlock title="执行失败" value={trace.error} />}
                      <section className="selection-detail">
                        <h3>本轮历史选择</h3>
                        {qa?.selections.map((selection) => (
                          <p key={selection.operationId}>{selection.indexes ? selection.indexes.map((index) => `[${index}]`).join(' → ') || '未选择历史' : statusLabels[selection.status]}</p>
                        ))}
                      </section>
                      <Button variant="outline" onClick={() => onInspect(trace.id, trace.id)}>
                        查看完整执行 <ArrowUpRight />
                      </Button>
                      <CallChildren trace={trace} id={trace.id} inspect={onInspect} />
                    </>
                  )}
                </TabsContent>
                {call && (
                  <TabsContent value="process">
                    <p className="subtle">同一调用内的执行与接收。复用结果仍指向本条记录的原始过程。</p>
                    {call.processes.map((process) => (
                      <details className="process-entry" key={process.sequence}>
                        <summary>
                          <span>
                            #{process.sequence} · {process.stage}.{process.type}
                          </span>
                          <span>
                            第 {process.round} 轮 · +{duration(process.offsetMs)}
                          </span>
                        </summary>
                        <DataBlock title="过程记录" value={process} />
                        {'resultOf' in process && <DataBlock title={`复用 #${process.resultOf}`} value={call.processes.find((item) => item.sequence === process.resultOf)} />}
                      </details>
                    ))}
                    {!call.processes.length && <p className="empty-note">没有内部过程条目。</p>}
                  </TabsContent>
                )}
                <TabsContent value="context">
                  <p className="subtle">记录捕获的上下文，不是运行中 Context 的实时副本。</p>
                  <DataBlock title="调用关联" value={{ contextId: call?.contextId ?? trace.facts.execution.contextId, executionRecordId: trace.id, parentRecordId: call?.parentId, operationInstanceId: call?.operationInstanceId }} />
                  <div className="detail-grid">
                    <DataBlock title="本次配置快照" value={trace.facts.execution.value.settings} />
                    <DataBlock title="固定消息范围" value={trace.facts.execution.value.transcriptRange} />
                  </div>
                </TabsContent>
                <TabsContent value="memory">
                  <MemoryAtCall trace={trace} call={call} memory={memory} />
                </TabsContent>
                {call && (
                  <TabsContent value="source">
                    <Source call={call} runtime={runtime} />
                  </TabsContent>
                )}
              </div>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
