import { Fragment, type ReactNode } from 'react';

/**
 * Tiny, dependency-free markdown renderer.
 * Supports fenced code blocks, **bold**, *italic*, `inline code`, bullet lists
 * and > blockquotes. Builds React nodes — never uses dangerouslySetInnerHTML.
 */

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE).filter((p) => p !== '');
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code className="inline-code" key={key}>
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (
      (part.startsWith('*') && part.endsWith('*') && part.length > 2) ||
      (part.startsWith('_') && part.endsWith('_') && part.length > 2)
    ) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function RichText({ text }: { text: string }) {
  const blocks = text.split(/```/);

  return (
    <div className="rich-text">
      {blocks.map((block, blockIndex) => {
        // Odd indices are fenced code blocks.
        if (blockIndex % 2 === 1) {
          const firstNewline = block.indexOf('\n');
          const lang = firstNewline > -1 ? block.slice(0, firstNewline).trim() : '';
          const code = (firstNewline > -1 ? block.slice(firstNewline + 1) : block).replace(/\n$/, '');
          return (
            <pre className="code-block" key={`code-${blockIndex}`}>
              {lang && <span className="code-lang">{lang}</span>}
              <code>{code}</code>
            </pre>
          );
        }

        const lines = block.split('\n').filter((l, i, arr) => !(l.trim() === '' && (i === 0 || i === arr.length - 1)));
        if (lines.length === 0) return null;

        const nodes: ReactNode[] = [];
        let listBuffer: string[] = [];

        const flushList = () => {
          if (listBuffer.length === 0) return;
          nodes.push(
            <ul className="md-list" key={`ul-${blockIndex}-${nodes.length}`}>
              {listBuffer.map((item, i) => (
                <li key={i}>{renderInline(item, `li-${blockIndex}-${nodes.length}-${i}`)}</li>
              ))}
            </ul>,
          );
          listBuffer = [];
        };

        lines.forEach((line, i) => {
          const trimmed = line.trim();
          const bullet = trimmed.match(/^[•\-*]\s+(.*)$/);
          if (bullet) {
            listBuffer.push(bullet[1]);
            return;
          }
          flushList();

          if (trimmed.startsWith('>')) {
            nodes.push(
              <blockquote className="md-quote" key={`q-${blockIndex}-${i}`}>
                {renderInline(trimmed.replace(/^>\s?/, ''), `q-${blockIndex}-${i}`)}
              </blockquote>,
            );
            return;
          }
          if (trimmed === '') {
            nodes.push(<div className="md-gap" key={`gap-${blockIndex}-${i}`} />);
            return;
          }
          nodes.push(
            <p className="md-p" key={`p-${blockIndex}-${i}`}>
              {renderInline(trimmed, `p-${blockIndex}-${i}`)}
            </p>,
          );
        });
        flushList();

        return <Fragment key={`block-${blockIndex}`}>{nodes}</Fragment>;
      })}
    </div>
  );
}
