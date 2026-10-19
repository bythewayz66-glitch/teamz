import { useEffect, useRef } from 'react';
import type { Agent } from '../types';
import { AgentAvatar } from './Avatar';

interface MentionAutocompleteProps {
  /** Ranked candidates. */
  agents: Agent[];
  /** Highlighted index (owned by the composer so keyboard + mouse agree). */
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (agent: Agent) => void;
  /** Caret-relative anchor, in px, from the composer wrapper. */
  top: number;
  left: number;
}

/**
 * The `@` popover. Rendered by the composer; never owns selection state itself
 * so that ↑/↓/Enter and the mouse can share one source of truth.
 */
export function MentionAutocomplete({
  agents,
  activeIndex,
  onHover,
  onPick,
  top,
  left,
}: MentionAutocompleteProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (agents.length === 0) return null;

  return (
    <div className="mention-pop" style={{ bottom: top, left }} role="listbox" aria-label="Mention an agent">
      <div className="mention-pop-head">
        <span>Mention an agent</span>
        <kbd>↑↓</kbd>
        <kbd>↵</kbd>
        <kbd>esc</kbd>
      </div>
      <ul ref={listRef}>
        {agents.map((agent, i) => (
          <li key={agent.id}>
            <button
              type="button"
              className={`mention-row${i === activeIndex ? ' is-on' : ''}`}
              // mousedown, not click: click fires after the textarea blurs and
              // the caret position is already lost.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(agent);
              }}
              onMouseEnter={() => onHover(i)}
              role="option"
              aria-selected={i === activeIndex}
            >
              <AgentAvatar agent={agent} size={24} showStatus={agent.status} />
              <span className="mention-name">{agent.name}</span>
              <span className="mention-model">{agent.origin?.role ?? agent.model}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
