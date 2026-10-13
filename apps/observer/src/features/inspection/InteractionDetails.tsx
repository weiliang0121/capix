import { useEffect, useState } from 'react';
import type { InteractionObservation } from '@capix/protocol';
import type { CallDetail } from '../../state/data.js';
import { useAppCommands } from '../../state/react.js';
import { errorMessage } from '../../lib/errors.js';
import { projectInteraction, type InteractionView } from '../../binding/interactions.js';

/** Only the selected call opens these metadata subscriptions; the graph never polls them. */
export function InteractionDetails({ call, parent }: { call: CallDetail; parent?: CallDetail }) {
  const { interactionLinks } = useAppCommands();
  const [links, setLinks] = useState<readonly string[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void interactionLinks(call.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setLinks(value.interactionIds);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      });
    return () => controller.abort();
  }, [call.id, call.resources.length, interactionLinks]);
  return (
    <section className="data-block" aria-label="外部交互">
      <h3>外部交互</h3>
      <p className="subtle">交互反馈与本次调用分别推进；反馈到达不代表业务结果已通过校验。</p>
      {error && (
        <p className="subtle" role="status">
          交互关联暂不可用：{error}
        </p>
      )}
      {!error && !links && (
        <p className="subtle" role="status">
          读取交互关联…
        </p>
      )}
      {!error && links?.length === 0 && <p className="subtle">尚无已记录的交互关联。</p>}
      {links?.map((id) => (
        <InteractionSubscription key={id} id={id} call={call} parent={parent} />
      ))}
    </section>
  );
}

function InteractionSubscription({ id, call, parent }: { id: string; call: CallDetail; parent?: CallDetail }) {
  const { observeInteraction } = useAppCommands();
  const [value, setValue] = useState<InteractionObservation>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setValue(undefined);
    setError('');
    void observeInteraction(
      call.id,
      id,
      (next) => {
        if (!controller.signal.aborted) setValue(next);
      },
      controller.signal,
    ).catch((failure) => {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    });
    return () => controller.abort();
  }, [call.id, id, observeInteraction]);
  return <InteractionCard view={projectInteraction({ id, value, error, call, parent })} />;
}

export function InteractionCard({ view }: { view: InteractionView }) {
  return (
    <article className="mb-3 rounded-lg border border-border p-4 text-sm" aria-label={`交互 ${view.id}`}>
      <div className="mb-2 break-all font-mono text-xs text-muted-foreground">交互 {view.id}</div>
      <p className="mb-2" role="status">
        {view.status}
      </p>
      {view.model !== undefined && (
        <p className="subtle">
          模型 {view.model} · 用途 {view.purpose}
        </p>
      )}
      {view.waitNotice && <p className="subtle">{view.waitNotice}</p>}
      <p className="subtle">{view.parentReceipt}</p>
      {view.resultError && <p className="subtle">{view.resultError}</p>}
      {view.observationNotice && (
        <p className="subtle" role="status">
          {view.observationNotice}
        </p>
      )}
    </article>
  );
}
