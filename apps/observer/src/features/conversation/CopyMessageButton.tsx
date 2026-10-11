import { Check, Copy } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

/** Copies the supplied original content, independently of presentation playback. */
export function CopyMessageButton({ content }: { content: string }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useLayoutEffect(() => {
    setStatus('idle');
    return () => {
      generation.current++;
      clearTimeout(timer.current);
    };
  }, [content]);

  async function copy() {
    const request = ++generation.current;
    clearTimeout(timer.current);
    setStatus('copying');
    try {
      await navigator.clipboard.writeText(content);
      if (generation.current !== request) return;
      setStatus('copied');
      timer.current = setTimeout(() => setStatus('idle'), 2000);
    } catch {
      if (generation.current !== request) return;
      setStatus('failed');
    }
  }

  return (
    <span className="message-copy">
      <span className="message-copy-feedback" role="status" aria-atomic="true">
        {status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请重试' : ''}
      </span>
      <button type="button" className="message-copy-button" aria-label="复制消息原文" disabled={status === 'copying'} onClick={() => void copy()}>
        {status === 'copied' ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </span>
  );
}
