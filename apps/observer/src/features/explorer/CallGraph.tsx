import { ChevronDown, ChevronRight, ArrowUpRight } from 'lucide-react';
import type { CallGraphModel, CallGraphNode } from '../../state/graph.js';
import { formatDuration } from './layout.js';

const levelLabels = { execution: 'E', operation: 'O', attempt: 'A' };
const statusLabels = { running: '运行中', succeeded: '完成', failed: '失败', unresolved: '上次运行未取得结束记录' };

function hasFailure(node: CallGraphNode): boolean {
  return node.status === 'failed' || node.reception?.status === 'failed' || node.children.some(hasFailure);
}

function family(node: CallGraphNode): string {
  if (node.name && ['selection', 'prepareContext', 'maintainContext'].includes(node.name)) return 'selection';
  if (node.name === 'answer' || node.name === 'processDocument') return 'answer';
  if (node.name === 'memory') return 'memory';
  return 'neutral';
}

interface TreeProps {
  expanded: ReadonlyMap<string, boolean>;
  toggle: (id: string, open: boolean) => void;
  inspect: (id: string) => void;
}

function CallNode({ node, expanded, toggle, inspect }: TreeProps & { node: CallGraphNode }) {
  const open = expanded.get(node.id) ?? (node.level === 'execution' || hasFailure(node));
  const childrenId = `call-children-${node.id}`;
  return (
    <li className={`call-tree-item explorer-family-${family(node)}`}>
      <div className={`call-tree-node${node.level === 'execution' ? ' call-tree-execution' : ''}`}>
        <button type="button" className="call-tree-inspect" onClick={() => inspect(node.id)} aria-label={`${node.label}，${statusLabels[node.status]}，查看调用详情`}>
          <div className="call-tree-heading">
            <span className="call-tree-level">{levelLabels[node.level]}</span>
            {node.order !== undefined && <span className="call-tree-order">{String(node.order).padStart(2, '0')}</span>}
            <strong>{node.label}</strong>
            <ArrowUpRight className="call-tree-link" size={12} />
          </div>
          {node.summary && <p className="call-tree-summary">{node.summary}</p>}
          <div className="call-tree-meta">
            <span className={`call-tree-status call-tree-status-${node.status}`}>{statusLabels[node.status]}</span>
            {node.reception && <span className={`call-tree-reception call-tree-reception-${node.reception.status}`}>{node.reception.label}</span>}
            {node.incomplete && <span>关系待补全</span>}
            <span className="call-tree-duration">{node.durationMs !== undefined ? formatDuration(node.durationMs) : node.status === 'running' ? '进行中' : '耗时未取得'}</span>
          </div>
        </button>
        {node.children.length > 0 && (
          <button type="button" className="call-tree-toggle" onClick={() => toggle(node.id, !open)} aria-expanded={open} aria-controls={childrenId} aria-label={`${open ? '收起' : '展开'}${node.label}的 ${node.children.length} 个子调用`}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{node.children.length} 个子调用</span>
          </button>
        )}
      </div>
      {node.children.length > 0 && open && (
        <ol id={childrenId} className="call-tree-children">
          {node.children.map((child) => (
            <CallNode key={child.id} node={child} expanded={expanded} toggle={toggle} inspect={inspect} />
          ))}
        </ol>
      )}
    </li>
  );
}

export function CallGraph({ graph, ...props }: TreeProps & { graph: CallGraphModel }) {
  return (
    <div className="call-graph">
      {graph.runtimeId && (
        <button type="button" className="call-graph-origin" onClick={() => props.inspect(graph.runtimeId!)}>
          所属 R 调用 <ArrowUpRight size={12} />
        </button>
      )}
      <ol className="call-tree-roots">
        {graph.roots.map((node) => (
          <CallNode key={node.id} node={node} {...props} />
        ))}
      </ol>
      {graph.detached.length > 0 && (
        <section className="call-graph-detached">
          <p>归属尚未完整 · 以下调用暂不连接</p>
          <ol className="call-tree-roots">
            {graph.detached.map((node) => (
              <CallNode key={node.id} node={node} {...props} />
            ))}
          </ol>
        </section>
      )}
      {graph.incomplete && <p className="call-graph-note">部分关系尚未取得，不推断缺失的调用或接纳结果。</p>}
    </div>
  );
}
