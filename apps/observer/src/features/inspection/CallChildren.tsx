import type { CallSpan } from '../../observation/types';
import { ArrowUpRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Status, duration } from './blocks';
export function CallChildren({ children, executionId, inspect }: { children: readonly CallSpan[]; executionId: string; inspect: (id: string, call?: string) => void }) {
  return (
    <div className="child-calls">
      {children.map((call) => (
        <Button key={call.id} variant="outline" className="child-call" onClick={() => inspect(executionId, call.id)}>
          <span>
            {call.recordType === 'execution' ? '执行' : call.recordType === 'attempt' ? '意图' : '操作'} · {call.label}
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
