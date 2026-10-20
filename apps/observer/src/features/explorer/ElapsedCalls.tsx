import { useMemo } from 'react';
import type { RoundView } from '../../state/data.js';
import { layoutInvocations } from './layout.js';
import { InvocationNode, laneHeight, laneNames } from './nodes.js';

/** An optional per-execution timing view; it shares no lane heights with other QAs. */
export function ElapsedCalls({ round, width, inspect }: { round: RoundView; width: number; inspect: (id: string) => void }) {
  const layout = useMemo(() => layoutInvocations(round), [round]);
  return (
    <div className="elapsed-calls">
      {(['group', 'node'] as const).map((level) => {
        const lanes = level === 'group' ? layout.operationLanes : layout.attemptLanes;
        return (
          <section key={level} className="elapsed-lane">
            <div className="elapsed-lane-label">{laneNames[level]}</div>
            <div className="elapsed-lane-nodes" style={{ height: lanes * laneHeight }}>
              {layout.calls
                .filter((node) => node.call.recordType === level)
                .map((node) => (
                  <InvocationNode key={node.call.id} item={node} columnWidth={width} onInspect={() => inspect(node.call.id)} />
                ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
