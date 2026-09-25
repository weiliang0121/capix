import { memo } from 'react';
import { Streamdown, defaultRehypePlugins, type Components } from 'streamdown';
import { isString } from 'es-toolkit/predicate';

// Message HTML is not an application surface. Keep Markdown and safe links only.
const rehypePlugins = [defaultRehypePlugins.sanitize!, defaultRehypePlugins.harden!];
const components: Components = {
  img: ({ src, alt }) =>
    isString(src) && /^https?:\/\//i.test(src) ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt || '图片'}（查看图片）
      </a>
    ) : (
      <span>{alt || '图片'}</span>
    ),
  strong: ({ children }) => <strong>{children}</strong>,
  span: ({ children, className }) => <span className={className}>{children}</span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

export const MessageContent = memo(function MessageContent({ content, markdown = false }: { content: string; markdown?: boolean }) {
  if (!markdown) return <div className="message-text">{content}</div>;
  return (
    <Streamdown className="message-text markdown-content" mode="static" controls={false} lineNumbers={false} skipHtml rehypePlugins={rehypePlugins} components={components}>
      {content}
    </Streamdown>
  );
});
