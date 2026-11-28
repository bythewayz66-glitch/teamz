import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceState } from '../types';
import { searchWorkspace, type SearchAction, type SearchResult } from '../lib/search';
import { formatRelative } from '../lib/format';
import { SearchIcon } from './Icons';

interface Props {
  open: boolean;
  onClose: () => void;
  state: Pick<WorkspaceState, 'agents' | 'conversations' | 'messages'>;
  onAction: (action: SearchAction) => void;
}

const GROUP_LABEL: Record<SearchResult['group'], string> = {
  agent: 'Agents',
  session: 'Sessions',
  setting: 'Settings',
};

/** Ctrl/Cmd+K palette: one box that finds agents, sessions (by what was said inside them) and settings. */
export function CommandPalette({ open, onClose, state, onAction }: Props) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setCursor(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(t);
      previousFocus.current?.focus?.();
    };
  }, [open]);

  const results = useMemo(() => (open ? searchWorkspace(state, query) : []), [open, state, query]);

  useEffect(() => setCursor(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, results]);

  if (!open) return null;

  const choose = (r: SearchResult | undefined) => {
    if (!r) return;
    onClose();
    onAction(r.action);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(results.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[cursor]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  let lastGroup: SearchResult['group'] | null = null;
  const empty = query.trim() && results.length === 0;

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search agents, sessions and settings" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <SearchIcon size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents, sessions, settings…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-activedescendant={results[cursor] ? `palette-opt-${cursor}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-results" id="palette-results" role="listbox" ref={listRef}>
          {results.map((r, i) => {
            const header = r.group !== lastGroup ? GROUP_LABEL[r.group] : null;
            lastGroup = r.group;
            return (
              <div key={r.id}>
                {header && (
                  <div className="palette-group">
                    {!query.trim() && r.group === 'session' ? 'Recent sessions' : !query.trim() && r.group === 'agent' ? 'Recent agents' : header}
                  </div>
                )}
                <button
                  id={`palette-opt-${i}`}
                  role="option"
                  aria-selected={i === cursor}
                  className={`palette-item${i === cursor ? ' is-active' : ''}`}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => choose(r)}
                >
                  <span className="palette-title">{r.title}</span>
                  <span className="palette-sub">
                    {r.subtitle}
                    {r.group === 'session' && r.at ? ` · ${formatRelative(r.at)}` : ''}
                  </span>
                  {r.snippet && (
                    <span className="palette-snippet">
                      {r.snippet.before}
                      <mark>{r.snippet.match}</mark>
                      {r.snippet.after}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
          {empty && <div className="palette-empty">Nothing matches “{query.trim()}”.</div>}
        </div>
        <footer className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}
