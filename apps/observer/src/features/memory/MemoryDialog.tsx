import { ArrowUpRight } from 'lucide-react';
import type { MemoryObservation, MemoryRecord } from '@capix-observer/protocol';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { DataBlock } from '../inspection/blocks';
import './memory.css';
export function ChangeCard({ record, onInspect }: { record: MemoryRecord; onInspect?: (id: string, call?: string) => void }) {
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
        {onInspect && record.executionId && (
          <Button variant="ghost" size="sm" onClick={() => onInspect(record.executionId!, record.operationId)}>
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
