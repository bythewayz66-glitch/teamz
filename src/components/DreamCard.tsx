import { useState } from 'react';
import type { HomeDream } from '../lib/agentHome';
import { timeAgo, timeUntil } from '../lib/agentHome';
import { describeCounts, type DreamReport, type SlotEntry } from '../lib/dream';

interface Props {
  dream: HomeDream;
  now: number;
  running: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onCadence: (cron: string) => void;
}

const OUTCOME_LABEL: Record<SlotEntry['outcome'], string> = {
  ran: 'Ran',
  skipped: 'Skipped',
  failed: 'Failed',
  missed: 'Missed — unexplained',
  pending: 'Due now',
};

const stamp = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function Report({ r, now, pinned }: { r: DreamReport; now: number; pinned?: boolean }) {
  return (
    <article className={`dream-report${pinned ? ' is-pinned' : ''}`} aria-label={pinned ? 'Pinned Dream report' : 'Earlier Dream report'}>
      <header>
        {pinned && <span className="dream-pin" title="The latest report stays pinned here">Pinned</span>}
        <span className={`kind-chip ${r.changed ? 'kind-warn' : 'kind-room'}`}>{r.changed ? 'Proposes changes' : 'Nothing to change'}</span>
        <span className="home-time" title={stamp(r.at)}>{timeAgo(r.at, now)}</span>
      </header>
      <p className="dream-summary">{r.summary}</p>
      {r.findings.length > 0 && (
        <ul className="dream-findings">
          {r.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      {r.proposals.length > 0 && (
        <div className="dream-proposals">
          <h3>Proposals for the Reviewer</h3>
          <ol>
            {r.proposals.map((p, i) => (
              <li key={i}>
                <span className="kind-chip kind-work">{p.target}</span> <strong>{p.change}</strong>
                <span className="dream-why">Because: {p.why}</span>
              </li>
            ))}
          </ol>
          <p className="home-foot">A Dream never edits the agent. These wait for a decision.</p>
        </div>
      )}
      <p className="home-foot">
        {r.source === 'runner'
          ? 'Written on the runner from its own Build Room activity.'
          : r.reviewed.messages === 0
            ? 'Reviewed its recent sessions.'
            : `Reviewed ${r.reviewed.messages} message${r.reviewed.messages === 1 ? '' : 's'} across ${r.reviewed.sessions} session${r.reviewed.sessions === 1 ? '' : 's'} since ${stamp(r.reviewed.sinceAt)}.`}
      </p>
    </article>
  );
}

/** Dream: the agent's scheduled self-review, its run record, and its pinned report. */
export function DreamCard({ dream, now, running, onEnable, onDisable, onCadence }: Props) {
  const [error, setError] = useState<string | null>(null);
  const guard = (fn: () => void) => () => {
    try {
      setError(null);
      fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That change was refused.');
    }
  };
  const hasRecord = dream.counts.planned + dream.counts.pending > 0;

  return (
    <section className="home-card home-dream" aria-labelledby="h-dream">
      <div className="dream-head">
        <h2 id="h-dream">
          Dream <span className="count">scheduled self-review</span>
          {dream.unread.length > 0 && <span className="kind-chip kind-warn dream-new">{dream.unread.length} new</span>}
        </h2>
        {dream.enrollable && (
          <div className="dream-controls">
            {dream.enabled && (
              <label className="dream-cadence">
                <span className="sr-only">Cadence</span>
                <select value={dream.cron} onChange={(e) => guard(() => onCadence(e.target.value))()} aria-label="How often this agent dreams">
                  {dream.cadences.map((c) => (
                    <option key={c.cron} value={c.cron}>{c.label}</option>
                  ))}
                  {!dream.cadences.some((c) => c.cron === dream.cron) && <option value={dream.cron}>{dream.cadenceLabel}</option>}
                </select>
              </label>
            )}
            <button className={`btn sm ${dream.enabled ? 'ghost' : 'primary'}`} onClick={guard(dream.enabled ? onDisable : onEnable)} aria-pressed={dream.enabled}>
              {dream.enabled ? 'Switch off' : 'Switch Dream on'}
            </button>
          </div>
        )}
      </div>

      {!dream.enrollable && !dream.runnerJob && (
        <p className="home-empty">
          Dream is not open to this agent yet. It starts with the Orchestrator, the Reviewer and the Website Currency Agent, and widens only once their Dreams prove stable.
        </p>
      )}
      {dream.enrollable && !dream.enabled && !dream.runnerJob && (
        <p className="home-empty">
          Off. When switched on, this agent re-reads its own recent sessions {dream.cadenceLabel.toLowerCase()} and pins a report here. It makes no model call when there is nothing new to review.
        </p>
      )}
      {error && <p role="alert" className="dream-error">{error}</p>}

      {(dream.enabled || dream.runnerJob) && (
        <p className="dream-status">
          {running ? 'Dreaming now…' : dream.nextAt !== null ? `Next Dream ${timeUntil(dream.nextAt, now)} (${dream.cadenceLabel.toLowerCase()}).` : 'Not scheduled.'}
          {dream.enabled ? ' Runs only while Teamz is open in a browser.' : ''}
          {dream.runnerJob ? ' A Dream job is also set up on the runner.' : ''}
        </p>
      )}

      {hasRecord && (
        <div className="dream-record">
          <h3>Run record, last {dream.windowDays} days</h3>
          <p className={`dream-counts${dream.counts.missed ? ' has-missed' : ''}`}>{describeCounts(dream.counts)}</p>
          <ul className="home-list">
            {dream.entries.map((e) => (
              <li key={`${e.source}:${e.slot}`} className="home-line">
                <strong>
                  <span className={`run-dot dream-${e.outcome}`} aria-hidden="true" /> {OUTCOME_LABEL[e.outcome]}
                  <span className="dream-when"> · {stamp(e.slot)}{e.source === 'runner' ? ' · runner' : ''}</span>
                </strong>
                {e.reason && <span>{e.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {dream.pinned ? (
        <Report r={dream.pinned} now={now} pinned />
      ) : (
        (dream.enabled || dream.runnerJob) && <p className="home-empty">No Dream report yet. The first one appears here after the first Dream runs.</p>
      )}

      {dream.history.length > 0 && (
        <details className="dream-history">
          <summary>Earlier reports ({dream.history.length})</summary>
          {dream.history.map((r) => (
            <Report key={r.id} r={r} now={now} />
          ))}
        </details>
      )}
    </section>
  );
}
