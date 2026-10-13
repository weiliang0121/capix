import { MessageContent } from '../../components/message-content.js';
import { useTextReveal } from '../../presentation/text/react.js';

/** Text reception and the local display clock have independent lifetimes. */
export function AnswerContent({ id, content, complete = true, reveal = false, format = 'markdown' }: { id: string; content: string; complete?: boolean; reveal?: boolean; format?: 'plain' | 'markdown' }) {
  const presentation = useTextReveal(id, { text: content, complete }, reveal);
  const displaying = presentation.phase !== 'finished';
  return (
    <div className="answer-content" data-message-key={id} data-presentation={presentation.phase}>
      <div aria-live="off" aria-busy={displaying}>
        <MessageContent content={presentation.text} format={format} complete={!displaying} />
      </div>
      {presentation.phase === 'revealing' && (
        <button type="button" className="answer-reveal-all" onClick={presentation.finish}>
          {complete ? '立即显示全文' : '显示已接收内容'}
        </button>
      )}
      <span className="sr-only" role="status" aria-atomic="true">
        {displaying ? '' : '回答已显示完整。'}
      </span>
    </div>
  );
}
