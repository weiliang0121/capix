import { useEffect, useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { useAppCommands } from '../../state/react';
import type { CallSpan } from '../../observation/types';
export function Source({ call }: { call: Pick<CallSpan, 'source'> }) {
  const { source: loadSource } = useAppCommands();
  const [text, setText] = useState('读取源码…');
  const path = call.source.split(' · ')[0]!;
  useEffect(() => {
    const controller = new AbortController();
    setText('读取源码…');
    loadSource(path, controller.signal)
      .then((source) => {
        if (!controller.signal.aborted) setText(source.content);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setText(error.message);
      });
    return () => controller.abort();
  }, [path, loadSource]);
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
