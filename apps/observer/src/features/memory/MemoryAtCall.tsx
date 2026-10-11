import type { CallMemory } from '../../state/data';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { ChangeCard } from './MemoryDialog';
import { MemoryResultSources } from './MemoryResultSources';
export function MemoryAtCall({ incoming, changes }: CallMemory) {
  return (
    <div className="detail-grid">
      <section>
        <h3 className="section-title">本次可见的记忆</h3>
        <p className="subtle">当时的操作输入快照；传入不等于模型采用。</p>
        <div className="memory-grid single">
          {incoming.map((item) => (
            <Card className="memory-card" key={item.id}>
              <CardHeader>
                <CardTitle>{item.topic}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="memory-content">{item.content}</p>
                <p className="subtle">原文依据：{item.sourceIndexes.map((source) => `[${source}]`).join(' ')}</p>
                <MemoryResultSources sources={item.sourceResults} />
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
