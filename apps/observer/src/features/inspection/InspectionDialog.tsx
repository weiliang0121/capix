import { useEffect, useState } from 'react';
import { ArrowUpRight, ChevronLeft } from 'lucide-react';
import type { Inspection } from '../../state/store';
import type { ExecutionDetail, RoundView } from '../../state/data';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { MemoryAtCall } from '../memory/MemoryAtCall';
import { CallChildren } from './CallChildren';
import { Source } from './Source';
import { DataBlock, TextBlock, Status, statusLabels, duration } from './blocks';
import './inspection.css';
export function InspectionDialog({ target, detail, loading, error, qa, number, onClose, onInspect }: { target?: Inspection; detail?: ExecutionDetail; loading: boolean; error: string; qa?: RoundView; number: number; onClose: () => void; onInspect: (id: string, call?: string) => void }) {
  const [tab, setTab] = useState('overview');
  useEffect(() => setTab('overview'), [target?.executionId, target?.callId]);
  const call = target?.callId ? detail?.calls.get(target.callId) : undefined;
  const runtimeCall = detail?.calls.get(detail.calls.get(detail.id)?.parentId ?? '');
  const answer = qa?.response?.content ?? detail?.answer ?? '本轮尚无已记录的回答。';
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
            问答 {String(number).padStart(2, '0')} {call ? ` / ${call.recordType === 'runtime' ? '运行调用' : call.recordType === 'execution' ? '执行' : call.recordType === 'operation' ? '操作' : '意图'}` : ''}
          </div>
          <DialogTitle>{call?.label ?? '这一轮交流'}</DialogTitle>
          <DialogDescription asChild>
            <div className="inline-meta">
              {detail ? (
                <>
                  <Status value={call?.status ?? detail.status} />
                  <span>
                    {duration(call ? call.durationMs : qa?.durationMs)} · {new Date(call?.startedAt ?? detail.startedAt).toLocaleString()}
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
        {detail && (
          <>
            <div className="inspector-meta">
              {call && (
                <Button variant="ghost" size="sm" onClick={() => onInspect(detail.id)}>
                  <ChevronLeft />
                  返回问答
                </Button>
              )}
              <code>记录 {call?.id ?? detail.id}</code>
            </div>
            <Tabs value={tab} onValueChange={setTab} className="inspector-tabs">
              <TabsList>
                <TabsTrigger value="overview">{call ? '输入 / 输出' : '交流 / 调用'}</TabsTrigger>
                {call && <TabsTrigger value="process">内部过程</TabsTrigger>}
                {call && <TabsTrigger value="relations">子调用接纳</TabsTrigger>}
                <TabsTrigger value="context">上下文</TabsTrigger>
                <TabsTrigger value="memory">记忆</TabsTrigger>
                {call?.source && <TabsTrigger value="source">执行源码</TabsTrigger>}
              </TabsList>
              <div className="dialog-scroll">
                <TabsContent value="overview">
                  {call ? (
                    <>
                      <div className="detail-stats">
                        <span>开始 +{duration(call.offsetMs)}</span>
                        <span>本地执行 {call.localRounds} 轮</span>
                        <span>调用目标 {call.target ?? call.callee}</span>
                      </div>
                      <div className="detail-grid">
                        <DataBlock title="输入" value={call.input} />
                        <DataBlock title={call.error ? '失败原因' : '最终结果'} value={call.error ?? call.output} />
                        {call.failure && <DataBlock title="失败归属" value={call.failure} />}
                      </div>
                      {call.parentId && (
                        <Button variant="ghost" size="sm" onClick={() => onInspect(detail.id, call.parentId)}>
                          查看父调用 <ArrowUpRight />
                        </Button>
                      )}
                      <CallChildren children={call.children} executionId={detail.id} inspect={onInspect} />
                    </>
                  ) : (
                    <>
                      <div className="detail-grid">
                        <TextBlock title={`用户 · [${qa?.inputIndex ?? '—'}]`} content={detail.inputContent} />
                        <TextBlock markdown title={`助手${qa?.response?.index === undefined ? '' : ` · [${qa.response.index}]`}`} content={answer} />
                      </div>
                      {detail.error && <DataBlock title="执行失败" value={detail.error} />}
                      {detail.failure && <DataBlock title="失败归属" value={detail.failure} />}
                      <section className="selection-detail">
                        <h3>本轮历史选择</h3>
                        {qa?.selections.map((selection) => (
                          <p key={selection.operationId}>{selection.indexes ? selection.indexes.map((index) => `[${index}]`).join(' → ') || '未选择历史' : statusLabels[selection.status]}</p>
                        ))}
                      </section>
                      <Button variant="outline" onClick={() => onInspect(detail.id, detail.id)}>
                        查看完整执行 <ArrowUpRight />
                      </Button>
                      {runtimeCall && (
                        <Button variant="ghost" onClick={() => onInspect(detail.id, runtimeCall.id)}>
                          查看所属运行调用 · {statusLabels[runtimeCall.status]} <ArrowUpRight />
                        </Button>
                      )}
                      <CallChildren children={detail.children} executionId={detail.id} inspect={onInspect} />
                    </>
                  )}
                </TabsContent>
                {call && (
                  <TabsContent value="process">
                    <p className="subtle">同一调用内的执行、正常接纳与异常处理。handling 表示异常处理阶段，复用结果指向本条记录的原始过程。</p>
                    {call.processEntries.map(({ record: process, reused }) => (
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
                        {'resultOf' in process && <DataBlock title={`复用 #${process.resultOf}`} value={reused} />}
                      </details>
                    ))}
                    {!call.processes.length && <p className="empty-note">没有内部过程条目。</p>}
                  </TabsContent>
                )}
                {call && (
                  <TabsContent value="relations">
                    <p className="subtle">由当前父调用记录：子调用返回与父层接纳是两个独立阶段。</p>
                    {call.relationEntries.map((entry) => (
                      <details className="process-entry" key={entry.eventSequence}>
                        <summary>
                          <span>
                            #{entry.eventSequence} · {entry.identity.key ?? '子调用'} · {relationLabels[entry.change.kind]}
                          </span>
                          <span>
                            父调用第 {entry.identity.parentRound} 轮 · +{duration(entry.offsetMs)}
                          </span>
                        </summary>
                        <DataBlock title="关系记录" value={entry} />
                        {entry.childId && detail.calls.has(entry.childId) && (
                          <Button variant="ghost" size="sm" onClick={() => onInspect(detail.id, entry.childId)}>
                            查看子调用 <ArrowUpRight />
                          </Button>
                        )}
                      </details>
                    ))}
                    {!call.relationEntries.length && <p className="empty-note">没有子调用关系条目。</p>}
                  </TabsContent>
                )}
                <TabsContent value="context">
                  <p className="subtle">记录捕获的上下文，不是运行中 Context 的实时副本。</p>
                  <DataBlock title="调用关联" value={{ contextId: call?.contextId ?? detail.contextId, executionRecordId: detail.id, parentRecordId: call?.parentId, operationInstanceId: call?.operationInstanceId }} />
                  {call?.recordType !== 'runtime' && (
                    <div className="detail-grid">
                      <DataBlock title="本次配置快照" value={detail.settings} />
                      <DataBlock title="固定消息范围" value={detail.transcriptRange} />
                    </div>
                  )}
                  <section>
                    <h3>资源运行事实</h3>
                    {(call?.resources ?? detail.resources).map((fact) => (
                      <DataBlock key={fact.id} title={`${fact.access} · ${fact.phase} · #${fact.sequence}`} value={fact} />
                    ))}
                    {!(call?.resources ?? detail.resources).length && <p className="empty-note">本次没有资源事实记录。</p>}
                  </section>
                </TabsContent>
                <TabsContent value="memory">
                  <MemoryAtCall {...(call?.memory ?? detail.memory)} />
                </TabsContent>
                {call?.source && (
                  <TabsContent value="source">
                    <Source call={call} />
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

const relationLabels = { attached: '已建立', returned: '子调用已返回', receiving: '父层接纳中', accepted: '父层已接纳', failed: '父层接纳失败' };
