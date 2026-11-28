import type { AgentHomeModel, HomeSession } from '../lib/agentHome';
import { timeAgo, timeUntil } from '../lib/agentHome';
import { AgentAvatar } from './Avatar';
import { PlusIcon, SettingsIcon } from './Icons';
import { DreamCard } from './DreamCard';
import { POLICY_LABEL, type ConnectionRow, type PolicyValue } from '../lib/connections';

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
  dreamRunning: boolean;
  onDreamEnable: () => void;
  onDreamDisable: () => void;
  onDreamCadence: (cron: string) => void;
  onSetPolicy: (rowId: ConnectionRow['id'], value: PolicyValue) => void;
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
  dreamRunning,
  onDreamEnable,
  onDreamDisable,
  onDreamCadence,
  onSetPolicy,
}: Props) {
  const { agent } = home;
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
            <span className="mono">{home.model}</span>
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
        <section className="home-warmth" aria-label="What I did last and what I do next">
          <p className="warm-last">{home.warmth.last}</p>
          <p className="warm-next">{home.warmth.next}</p>
          {interrupted && (
            <button className="btn primary sm" onClick={() => onResume(interrupted.id)}>
              Resume “{interrupted.name}”
            </button>
          )}
        </section>

        <div className="home-grid">
          <DreamCard dream={home.dream} now={now} running={dreamRunning} onEnable={onDreamEnable} onDisable={onDreamDisable} onCadence={onDreamCadence} />

          <section className="home-card home-sessions" aria-labelledby="h-sessions">
            <h2 id="h-sessions">Sessions <span className="count">{home.sessions.length}</span></h2>
            {home.sessions.length === 0 && <p className="home-empty">No sessions yet. Start one and it will be kept here.</p>}
            <ul className="home-list">
              {home.sessions.slice(0, 12).map((s) => (
                <li key={s.id}>
                  <button className="home-row" onClick={() => onOpenSession(s.id)}>
                    <span className="home-row-top">
                      <strong>{s.name}</strong>
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
            {home.sessions.length > 12 && <p className="home-more">{home.sessions.length - 12} older sessions — find them with search (Ctrl/Cmd+K).</p>}
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
                  <li key={s.label} className="chip" title={s.source === 'instructions' ? 'Taken from the agent’s own instructions' : s.source === 'dream' ? 'Switched on in the Dream card' : undefined}>
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

          <section className="home-card home-card-wide" aria-labelledby="h-conn">
            <h2 id="h-conn">Connections <span className="count">{home.reach.filter((r) => r.state === 'in-use' || r.state === 'available').length}</span></h2>
            <p className="home-foot">What this agent can reach outside Teamz. A declared policy is only protection where the row says it is enforced.</p>
            <ul className="reach-list">
              {home.reach.map((r) => (
                <li key={r.id} className={`reach-row is-${r.state}`}>
                  <div className="reach-top">
                    <strong>{r.label}</strong>
                    <span className={`reach-state is-${r.state}`}>{r.stateLabel}</span>
                    {r.policy !== null &&
                      (r.editable ? (
                        <label className="reach-policy">
                          <span className="sr-only">{r.label} policy</span>
                          <select value={r.policy} onChange={(e) => onSetPolicy(r.id, e.target.value as PolicyValue)}>
                            {(Object.keys(POLICY_LABEL) as PolicyValue[]).map((v) => (
                              <option key={v} value={v}>{POLICY_LABEL[v]}</option>
                            ))}
                          </select>
                        </label>
                      ) : (
                        <span className="reach-policy-fixed">{POLICY_LABEL[r.policy]}</span>
                      ))}
                    {r.enforcement && <span className={`reach-enf is-${r.enforcement}`}>{r.enforcement === 'enforced' ? 'Enforced' : 'Not enforced'}</span>}
                  </div>
                  <p className="reach-detail">{r.detail}</p>
                  {r.enforcementNote && <p className="reach-note">{r.enforcementNote}</p>}
                  {r.calls !== null && (
                    <p className="reach-note">{r.calls} call{r.calls === 1 ? '' : 's'} in 14 days{r.lastAt ? `, last ${timeAgo(r.lastAt, now)}` : ''}.</p>
                  )}
                </li>
              ))}
            </ul>
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
