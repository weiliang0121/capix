import { MessageContent } from '../../components/message-content.js';
import { useTextReveal } from '../../presentation/text/react.js';

/** The accepted answer is already complete, even while memory post-processing is still running. */
export function AnswerContent({ id, content, reveal = false }: { id: string; content: string; reveal?: boolean }) {
  const presentation = useTextReveal(id, { text: content, complete: true }, reveal);
  const displaying = presentation.phase !== 'finished';
  return (
    <div className="answer-content" data-message-key={id} data-presentation={presentation.phase}>
      <div aria-live="off" aria-busy={displaying}>
        <MessageContent content={presentation.text} format="markdown" complete={!displaying} />
      </div>
      {displaying && (
        <button type="button" className="answer-reveal-all" onClick={presentation.finish}>
          立即显示全文
        </button>
      )}
      <span className="sr-only" role="status" aria-atomic="true">
        {displaying ? '' : '回答已显示完整。'}
      </span>
    </div>
  );
}
