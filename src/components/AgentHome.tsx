import { useState } from 'react';
import type { RetentionPolicy } from '../types';
import type { AgentHomeModel, HomeSession, SessionSort } from '../lib/agentHome';
import { filterSessions, timeAgo, timeUntil } from '../lib/agentHome';
import { RETENTION_PRESETS, retentionKey } from '../lib/sessions';
import { AgentAvatar } from './Avatar';
import { PlusIcon, SettingsIcon } from './Icons';

interface Props {
  home: AgentHomeModel;
  now: number;
  /** True when the runner could not be reached and schedule data is a saved copy. */
  runnerStale: boolean;
  runnerFetchedAt: number | null;
  onOpenSession: (id: string) => void;
  onNewSession: () => void;
  onResume: (id: string) => void;
  onOpenSettings: () => void;
  onOpenCostRate: () => void;
  onSetDefaultRetention: (policy: RetentionPolicy | undefined) => void;
}

const KIND_LABEL: Record<HomeSession['kind'], string> = { chat: 'Chat', work: 'Work', room: 'Room' };

/** One page per agent: what it is, what it did last, what it will do next. */
export function AgentHome({
  home,
  now,
  runnerStale,
  runnerFetchedAt,
  onOpenSession,
  onNewSession,
  onResume,
  onOpenSettings,
  onOpenCostRate,
  onSetDefaultRetention,
}: Props) {
  const { agent } = home;
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SessionSort>('recent');
  const [showAll, setShowAll] = useState(false);
  const visible = filterSessions(home.sessions, query, sort);
  const shown = showAll || query.trim() ? visible : visible.slice(0, 12);
  const defaultKey = agent.sessionRetention ? retentionKey(agent.sessionRetention) : '';
  const interrupted = home.sessions.find((s) => s.status === 'interrupted');

  return (
    <main className="chat-pane agent-home" aria-label={`${agent.name} home`}>
      <header className="home-head">
        <AgentAvatar agent={agent} size={56} />
        <div className="home-id">
          <h1>{agent.name}</h1>
          <p>
            <span className={`home-status tone-${home.status.tone}`} title={home.status.detail}>
              {home.status.label}
            </span>
            <span className="dot-sep">·</span>
            <span className="mono" title={home.model}>{home.modelLabel}</span>
            {home.stepLimit ? (
              <>
                <span className="dot-sep">·</span>
                <span title="Tool steps allowed per request">up to {home.stepLimit} steps</span>
              </>
            ) : null}
            {home.provider && (
              <>
                <span className="dot-sep">·</span>
                <span>{home.provider}</span>
              </>
            )}
          </p>
        </div>
        <div className="home-actions">
          <button className="btn primary sm" onClick={onNewSession}>
            <PlusIcon size={13} /> New session
          </button>
          <button className="btn ghost sm" onClick={onOpenSettings}>
            <SettingsIcon size={13} /> Settings
          </button>
        </div>
      </header>

      <div className="home-scroll">
        <section className="home-warmth" aria-label="Last activity and next scheduled run">
          <p className="warm-last">{home.warmth.last}</p>
          <p className="warm-next">{home.warmth.next}</p>
          {interrupted && (
            <button className="btn primary sm" onClick={() => onResume(interrupted.id)}>
              Resume “{interrupted.name}”
            </button>
          )}
        </section>

        <div className="home-grid">
          <section className="home-card home-sessions" aria-labelledby="h-sessions">
            <h2 id="h-sessions">Sessions <span className="count">{home.sessions.length}</span></h2>
            {home.sessions.length > 1 && (
              <div className="session-tools">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search this agent’s sessions…"
                  aria-label="Search this agent’s sessions"
                />
                <select value={sort} onChange={(e) => setSort(e.target.value as SessionSort)} aria-label="Sort sessions">
                  <option value="recent">Most recent</option>
                  <option value="name">Name</option>
                </select>
              </div>
            )}
            {home.sessions.length === 0 && <p className="home-empty">No sessions yet. Start one and it will be kept here.</p>}
            <ul className="home-list">
              {shown.map((s) => (
                <li key={s.id}>
                  <button className="home-row" onClick={() => onOpenSession(s.id)}>
                    <span className="home-row-top">
                      <strong>{s.starred ? '★ ' : ''}{s.name}</strong>
                      <span className={`kind-chip kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                      {s.status === 'interrupted' && <span className="kind-chip kind-warn">Interrupted</span>}
                      <span className="home-time">{timeAgo(s.lastAt, now)}</span>
                    </span>
                    <span className="home-row-sub">{s.preview}</span>
                    <span className="home-row-retention">{s.messageCount} message{s.messageCount === 1 ? '' : 's'} · {s.retention}</span>
                  </button>
                </li>
              ))}
            </ul>
            {query.trim() && visible.length === 0 && <p className="home-empty">No session here mentions “{query.trim()}”.</p>}
            {!query.trim() && visible.length > 12 && (
              <button className="link-btn home-more" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show fewer' : `Show all ${visible.length} sessions`}
              </button>
            )}
            <div className="retention-default">
              <label>
                <span>Session auto-delete for new sessions</span>
                <select
                  value={defaultKey}
                  onChange={(e) =>
                    onSetDefaultRetention(RETENTION_PRESETS.find((p) => retentionKey(p.policy) === e.target.value)?.policy)
                  }
                  aria-label="Default retention for this agent's new sessions"
                >
                  <option value="">Built-in (chats kept, work 90 days)</option>
                  {RETENTION_PRESETS.map((p) => (
                    <option key={retentionKey(p.policy)} value={retentionKey(p.policy)}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="home-foot">Applies to sessions started from now on. Starred sessions are never deleted.</span>
            </div>
          </section>

          <section className="home-card" aria-labelledby="h-triggers">
            <h2 id="h-triggers">Triggers <span className="count">{home.triggers.length}</span></h2>
            {home.triggers.length === 0 && <p className="home-empty">Nothing wakes this agent on its own.</p>}
            <ul className="home-list">
              {home.triggers.map((t) => (
                <li key={t.id} className="home-line">
                  <strong>{t.name}</strong>
                  <span>
                    {t.when}
                    {t.nextAt !== null ? ` · next ${timeUntil(t.nextAt, now)}` : t.note ? ` · ${t.note}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            <p className="home-foot">
              {runnerFetchedAt
                ? runnerStale
                  ? `Runner not reachable; schedule as of ${timeAgo(runnerFetchedAt, now)}.`
                  : `Runner checked ${timeAgo(runnerFetchedAt, now)}.`
                : 'Runner not reached yet; only schedules set in this browser are shown.'}
            </p>
          </section>

          <section className="home-card" aria-labelledby="h-skills">
            <h2 id="h-skills">Skills <span className="count">{home.skills.length}</span></h2>
            {home.skills.length === 0 ? (
              <p className="home-empty">No skills declared for this agent yet. Add some in its settings.</p>
            ) : (
              <ul className="chip-list">
                {home.skills.map((s) => (
                  <li key={s.label} className="chip" title={s.source === 'instructions' ? 'Taken from the agent’s own instructions' : undefined}>
                    {s.label}
                    {s.level ? <em>{s.level}/5</em> : null}
                  </li>
                ))}
              </ul>
            )}
            {home.skills.some((s) => s.source === 'instructions') && <p className="home-foot">From the agent’s instructions, not a declared skill list.</p>}
          </section>

          <section className="home-card" aria-labelledby="h-tools">
            <h2 id="h-tools">Tools <span className="count">{home.tools.length}</span></h2>
            {home.tools.length === 0 ? (
              <p className="home-empty">No tools enabled; it answers from the model alone.</p>
            ) : (
              <ul className="home-list">
                {home.tools.map((t) => (
                  <li key={t.id} className="home-line">
                    <strong>{t.label}</strong>
                    <span>{t.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="home-card" aria-labelledby="h-conn">
            <h2 id="h-conn">Connections</h2>
            <ul className="home-list">
              {home.connections.map((c) => (
                <li key={c.label} className="home-line">
                  <strong>{c.label}</strong>
                  <span>{c.detail}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="home-card" aria-labelledby="h-runs">
            <h2 id="h-runs">Recent runs</h2>
            {home.runRecord && (
              <p className="run-record">
                {home.runRecord.sentence}
                {home.runRecord.noRecord.length > 0 && (
                  <span className="home-foot">
                    {' '}
                    Nothing on record in 7 days for {home.runRecord.noRecord.map((n) => `“${n}”`).join(', ')}; its misses cannot be counted.
                  </span>
                )}
              </p>
            )}
            {home.recentRuns.length === 0 && <p className="home-empty">No scheduled runs recorded yet.</p>}
            <ul className="home-list">
              {home.recentRuns.map((r) => (
                <li key={r.id} className="home-line">
                  <strong>
                    <span className={`run-dot run-${r.outcome}`} aria-label={r.outcome} /> {r.title}
                  </strong>
                  <span>
                    {timeAgo(r.at, now)}
                    {r.detail ? ` · ${r.detail}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="home-card" aria-labelledby="h-cost">
            <h2 id="h-cost">Cost to date</h2>
            <p className="cost-big">{home.cost.dollarsLabel ?? home.cost.tokensLabel}</p>
            {home.cost.dollarsLabel && <p className="home-foot">{home.cost.tokensLabel}</p>}
            {!home.cost.dollarsLabel && (
              <p className="home-foot">
                No price set, so this is tokens only.{' '}
                <button className="link-btn" onClick={onOpenCostRate}>Set a rate</button> to see dollars.
              </p>
            )}
            <p className="home-foot">
              {home.cost.since ? `Counted since ${home.cost.since}, the first day Teamz saw usage.` : 'No usage seen yet.'}
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
