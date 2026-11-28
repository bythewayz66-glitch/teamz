import { useMemo, useState } from 'react';
import type { Agent } from '../types';
import { Modal } from './Modal';
import { timeAgo } from '../lib/agentHome';
import { formatDollars, formatTokens, type CostRate } from '../lib/usageLedger';
import {
  METERING,
  RUNNER_PACING,
  formatSpan,
  type BudgetRow,
  type CreditHealth,
  type CreditUnit,
  type FleetHealth,
  type HealthState,
  type QueueDrain,
  type UsageReport,
  type UsageRow,
} from '../lib/metering';
import type { UseMetering } from '../store/useMetering';

type Tab = 'usage' | 'providers' | 'budgets' | 'health' | 'pacing';
const TABS: Array<[Tab, string]> = [['usage', 'Usage'], ['providers', 'Providers & credit'], ['budgets', 'Budgets'], ['health', 'Fleet health'], ['pacing', 'Pacing']];
const HEALTH_LABEL: Record<HealthState, string> = { active: 'Active', sleeping: 'Sleeping', starved: 'Starved', parked: 'Parked', 'never-run': 'Never run' };
const HEALTH_ORDER: HealthState[] = ['parked', 'never-run', 'starved', 'sleeping', 'active'];

interface Props {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  usage: UsageReport;
  credits: CreditHealth[];
  budgets: BudgetRow[];
  health: FleetHealth;
  drainFor: (gapMs: number) => QueueDrain;
  metering: UseMetering;
  rate: CostRate | null;
  runnerStale: boolean;
  onOpenAgentHome: (agentId: string) => void;
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(v >= 0.1 && v < 0.995 ? 0 : 1)}%`);
const fmtLimit = (n: number, unit: string) => (unit === 'dollars' ? formatDollars(n) : `${formatTokens(n)} ${unit}`);

function UsageTable({ title, rows, rate, cap }: { title: string; rows: UsageRow[]; rate: CostRate | null; cap?: number }) {
  const shown = cap ? rows.slice(0, cap) : rows;
  return (
    <div>
      <h3>{title}</h3>
      <div className="meter-table-wrap">
        <table className="meter-table">
          <thead><tr><th>Name</th><th>Tokens</th><th>Calls</th><th>Share</th>{rate && <th>$</th>}</tr></thead>
          <tbody>
            {shown.length === 0 && <tr><td colSpan={rate ? 5 : 4} className="lib-muted">Nothing observed.</td></tr>}
            {shown.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td>{formatTokens(r.bucket.totalTokens)}</td>
                <td>{r.bucket.calls}</td>
                <td>{pct(r.callShare)}</td>
                {rate && <td>{r.dollars === null ? '—' : formatDollars(r.dollars)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cap && rows.length > cap && <p className="meter-note">Top {cap} of {rows.length}.</p>}
    </div>
  );
}

export function MeteringPanel({ open, onClose, agents, usage, credits, budgets, health, drainFor, metering, rate, runnerStale, onOpenAgentHome }: Props) {
  const [tab, setTab] = useState<Tab>('usage');
  const [filter, setFilter] = useState<'all' | HealthState>('all');
  const [err, setErr] = useState<string | null>(null);
  const [cr, setCr] = useState<{ provider: string; unit: CreditUnit; balance: string }>({ provider: '', unit: 'tokens', balance: '' });
  const [bd, setBd] = useState<{ scope: string; period: 'day' | 'week'; unit: CreditUnit; limit: string; note: string }>({ scope: 'fleet', period: 'day', unit: 'tokens', limit: '', note: '' });
  const [gapMin, setGapMin] = useState('15');
  const [gapNote, setGapNote] = useState('');
  const [decision, setDecision] = useState<{ id: string; by: string; note: string }>({ id: '', by: '', note: '' });

  const providers = useMemo(() => usage.byProvider.map((p) => p.key), [usage.byProvider]);
  const rows = useMemo(
    () => health.agents.filter((a) => filter === 'all' || a.state === filter).sort((a, b) => HEALTH_ORDER.indexOf(a.state) - HEALTH_ORDER.indexOf(b.state) || a.name.localeCompare(b.name)),
    [health.agents, filter],
  );
  const gapMs = Math.round(Number(gapMin) * 60_000);
  const gapValid = Number.isFinite(gapMs) && gapMs >= 10_000;
  const current = drainFor(RUNNER_PACING.minDispatchGapMs);
  const proposed = gapValid ? drainFor(gapMs) : null;
  const warn = credits.filter((c) => c.status === 'low' || c.status === 'critical' || c.status === 'exhausted');
  const afterDecide = (e: string | null) => { setErr(e); if (!e) setDecision({ id: '', by: '', note: '' }); };

  const DecisionForm = ({ id, onDecide }: { id: string; onDecide: (d: 'approved' | 'rejected', by: string, note: string) => string | null }) => (
    decision.id !== id ? (
      <button className="btn ghost sm" onClick={() => { setErr(null); setDecision({ id, by: '', note: '' }); }}>Record Reviewer decision</button>
    ) : (
      <span className="meter-form">
        <label>Recorded by<input value={decision.by} onChange={(e) => setDecision({ ...decision, by: e.target.value })} placeholder="Reviewer" /></label>
        <label>Reason<input value={decision.note} onChange={(e) => setDecision({ ...decision, note: e.target.value })} /></label>
        <button className="btn sm" onClick={() => afterDecide(onDecide('approved', decision.by, decision.note))}>Approved</button>
        <button className="btn ghost sm" onClick={() => afterDecide(onDecide('rejected', decision.by, decision.note))}>Rejected</button>
      </span>
    )
  );

  return (
    <Modal open={open} onClose={onClose} title="Usage & fleet health" subtitle={`Spend, provider credit, budgets and agent health over the last ${usage.windowDays} days`} width={1080}>
      <div className="meter">
        <p className="meter-note" role="note">
          Counts only what this browser has seen: usage days since {usage.since ?? 'never'} ({usage.observedDays} of {usage.windowDays} days observed){runnerStale ? '; the runner was unreachable, so run records are from the last saved copy' : ''}. Every total is a lower bound. Dollars appear only once a cost rate is set.
        </p>
        {warn.length > 0 && (
          <div className="meter-find is-warn" role="alert">
            {warn.map((c) => <div key={c.provider}><strong>{c.provider}</strong>: {c.status === 'exhausted' ? 'credit exhausted' : `credit ${c.status}`}. {c.reason} <em>(your entered balance)</em></div>)}
          </div>
        )}
        <div className="lib-tabs" role="tablist" aria-label="Usage and health views">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`lib-tab${tab === t ? ' is-active' : ''}`} onClick={() => { setTab(t); setErr(null); }}>{label}</button>
          ))}
        </div>
        {err && <p className="meter-find is-warn" role="alert">{err}</p>}

        {tab === 'usage' && (
          <div>
            <div className="meter-cards">
              <div className="meter-card"><b>{formatTokens(usage.total.totalTokens)}</b><span>tokens, {usage.windowDays} days</span></div>
              <div className="meter-card"><b>{usage.total.calls}</b><span>model calls</span></div>
              <div className="meter-card"><b>{usage.totalDollars === null ? '—' : formatDollars(usage.totalDollars)}</b><span>{usage.totalDollars === null ? 'set a cost rate for dollars' : 'at your entered rate'}</span></div>
              <div className="meter-card"><b>{usage.observedDays}/{usage.windowDays}</b><span>days observed</span></div>
            </div>
            <div className={`meter-find${usage.providerConcentrated ? ' is-warn' : ''}`} style={{ marginTop: 10 }}>
              <strong>Concentration.</strong>{' '}
              {usage.topProvider ? <>{usage.topProvider.label} carried {pct(usage.topProvider.callShare)} of calls{usage.providerConcentrated ? `, above the ${METERING.providerShareLimit * 100}% line` : ''}. </> : 'No calls observed. '}
              {usage.topAgent && <>{usage.topAgent.label} made {pct(usage.topAgent.callShare)} of calls and {pct(usage.topAgent.tokenShare)} of tokens.</>}
              <p className="meter-note">Provider and model are each agent’s configured route. A call rescued onto another provider is not visible here.</p>
            </div>
            <div className="meter-split" style={{ marginTop: 10 }}>
              <UsageTable title="By agent" rows={usage.byAgent} rate={rate} cap={15} />
              <UsageTable title="By model" rows={usage.byModel} rate={rate} cap={15} />
              <UsageTable title="By provider" rows={usage.byProvider} rate={rate} />
            </div>
            <h3 style={{ marginTop: 12 }}>By day (UTC)</h3>
            <div className="meter-table-wrap">
              <table className="meter-table">
                <thead><tr><th>Day</th><th>Tokens</th><th>Calls</th>{rate && <th>$</th>}<th /></tr></thead>
                <tbody>
                  {[...usage.byDay].reverse().map((d) => {
                    const max = Math.max(1, ...usage.byDay.map((x) => x.bucket.totalTokens));
                    return (
                      <tr key={d.date} className={d.observed ? '' : 'meter-day-off'}>
                        <td>{d.date}</td>
                        <td>{d.observed ? formatTokens(d.bucket.totalTokens) : 'not observed'}</td>
                        <td>{d.observed ? d.bucket.calls : '—'}</td>
                        {rate && <td>{d.dollars === null ? '—' : formatDollars(d.dollars)}</td>}
                        <td>{d.observed && <span className="meter-bar" style={{ width: `${Math.max(2, (d.bucket.totalTokens / max) * 140)}px` }} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'providers' && (
          <div>
            <p className="meter-note">Teamz cannot read a provider’s balance. Enter what you know; Teamz subtracts the use it has observed since and warns when about {METERING.creditLowDays} days remain at the recent burn rate, before the provider fails.</p>
            <div className="meter-table-wrap" style={{ marginTop: 8 }}>
              <table className="meter-table">
                <thead><tr><th>Provider</th><th>Status</th><th>Balance you entered</th><th>Left</th><th>Burn / day</th><th>Days left</th><th /></tr></thead>
                <tbody>
                  {credits.length === 0 && <tr><td colSpan={7} className="lib-muted">No balances entered. No credit status can be shown.</td></tr>}
                  {credits.map((c) => (
                    <tr key={c.provider}>
                      <td>{c.provider}</td>
                      <td><span className={`status-chip is-${c.status}`} title={c.reason}>{c.status}</span></td>
                      <td>{fmtLimit(c.enteredBalance, c.unit)} <em>(user-entered)</em></td>
                      <td>{c.remaining === null ? '—' : fmtLimit(Math.round(c.remaining), c.unit)}</td>
                      <td>{c.burnPerDay === null ? '—' : fmtLimit(Math.round(c.burnPerDay), c.unit)}</td>
                      <td>{c.daysLeft === null ? '—' : c.daysLeft.toFixed(1)}</td>
                      <td><button className="link-btn" onClick={() => metering.removeCredit(c.provider)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {credits.map((c) => <p key={c.provider} className="meter-note">{c.provider}: {c.reason}</p>)}
            <form className="meter-form" style={{ marginTop: 10 }} onSubmit={(e) => {
              e.preventDefault();
              const n = Number(cr.balance);
              if (!cr.provider.trim() || !Number.isFinite(n) || n < 0) { setErr('Pick a provider and enter a balance of zero or more.'); return; }
              setErr(null);
              metering.setCredit({ provider: cr.provider.trim(), unit: cr.unit, balance: n, enteredAt: Date.now() });
              setCr({ ...cr, balance: '' });
            }}>
              <label>Provider<input list="meter-providers" value={cr.provider} onChange={(e) => setCr({ ...cr, provider: e.target.value })} /></label>
              <datalist id="meter-providers">{providers.map((p) => <option key={p} value={p} />)}</datalist>
              <label>Unit<select value={cr.unit} onChange={(e) => setCr({ ...cr, unit: e.target.value as CreditUnit })}><option value="tokens">tokens</option><option value="calls">calls</option><option value="dollars">dollars</option></select></label>
              <label>Balance now<input type="number" min={0} value={cr.balance} onChange={(e) => setCr({ ...cr, balance: e.target.value })} /></label>
              <button className="btn sm" type="submit">Save balance</button>
            </form>
          </div>
        )}

        {tab === 'budgets' && (
          <div>
            <p className="meter-note">A budget is a proposal until the Reviewer’s decision is recorded as approved. Proposed limits show what they would read as but bind nothing. Approved limits are shown against observed use; Teamz warns but does not stop the runner.</p>
            <div className="meter-table-wrap" style={{ marginTop: 8 }}>
              <table className="meter-table">
                <thead><tr><th>Scope</th><th>Limit</th><th>Used</th><th>State</th><th>Decision</th></tr></thead>
                <tbody>
                  {budgets.length === 0 && <tr><td colSpan={5} className="lib-muted">No budgets yet.</td></tr>}
                  {budgets.map((r) => (
                    <tr key={r.budget.id}>
                      <td>{r.label}<br /><span className="lib-muted">per {r.budget.period}</span></td>
                      <td>{fmtLimit(r.budget.limit, r.budget.unit)} <span className={`status-chip is-${r.budget.status}`}>{r.budget.status}</span></td>
                      <td>{r.used === null ? '—' : fmtLimit(Math.round(r.used), r.budget.unit)}{r.fraction !== null && r.budget.status === 'approved' ? ` (${pct(r.fraction)})` : ''}</td>
                      <td><span className={`status-chip is-${r.state}`}>{r.state === 'no-approved-limit' ? 'no approved limit' : r.state}</span>{r.wouldBe && <div className="lib-muted">would read: {r.wouldBe}</div>}</td>
                      <td className="wrap">
                        {r.budget.decision ? <span className="lib-muted">{r.budget.decision.by}, {new Date(r.budget.decision.at).toISOString().slice(0, 10)}: {r.budget.decision.note}</span> : r.budget.note && <span className="lib-muted">{r.budget.note}</span>}
                        {r.budget.status === 'proposed' && <div><DecisionForm id={r.budget.id} onDecide={(d, by, note) => metering.decide(r.budget.id, d, by, note)} /></div>}
                        <div className="lib-muted">{r.note}</div>
                        <button className="link-btn" onClick={() => metering.removeBudget(r.budget.id)}>Remove</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <form className="meter-form" style={{ marginTop: 10 }} onSubmit={(e) => {
              e.preventDefault();
              const n = Number(bd.limit);
              const e1 = metering.propose({ scope: bd.scope === 'fleet' ? { kind: 'fleet' } : { kind: 'agent', agentId: bd.scope }, period: bd.period, unit: bd.unit, limit: n, note: bd.note.trim() });
              setErr(e1);
              if (!e1) setBd({ ...bd, limit: '', note: '' });
            }}>
              <label>Scope<select value={bd.scope} onChange={(e) => setBd({ ...bd, scope: e.target.value })}><option value="fleet">Whole fleet</option>{agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              <label>Per<select value={bd.period} onChange={(e) => setBd({ ...bd, period: e.target.value as 'day' | 'week' })}><option value="day">day</option><option value="week">week</option></select></label>
              <label>Unit<select value={bd.unit} onChange={(e) => setBd({ ...bd, unit: e.target.value as CreditUnit })}><option value="tokens">tokens</option><option value="calls">calls</option><option value="dollars">dollars</option></select></label>
              <label>Limit<input type="number" min={0} value={bd.limit} onChange={(e) => setBd({ ...bd, limit: e.target.value })} /></label>
              <label>Why<input value={bd.note} onChange={(e) => setBd({ ...bd, note: e.target.value })} /></label>
              <button className="btn sm" type="submit">Propose budget</button>
            </form>
          </div>
        )}

        {tab === 'health' && (
          <div>
            <div className="meter-cards">
              {HEALTH_ORDER.map((s) => (
                <button key={s} className="meter-card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setFilter(filter === s ? 'all' : s)} aria-pressed={filter === s}>
                  <b>{health.counts[s]}</b><span>{HEALTH_LABEL[s]}</span>
                </button>
              ))}
              <div className="meter-card"><b>{health.agents.length}</b><span>agents{filter !== 'all' ? ` · showing ${HEALTH_LABEL[filter]}` : ''}</span></div>
            </div>
            <details className="fleet-sources" style={{ margin: '10px 0' }}>
              <summary>How each state is decided</summary>
              <ul>
                <li><strong>Parked</strong>: a job of this agent is awaiting approval, or a dispatch has been open longer than {formatSpan(METERING.parkedDispatchedMs)} (the deadline is 330 s).</li>
                <li><strong>Never run</strong>: scheduled work exists, but no run, model call or channel message has ever been recorded.</li>
                <li><strong>Starved</strong>: scheduled work exists and nothing was recorded for more than {METERING.starvedCadenceFactor}× its cadence plus {formatSpan(METERING.starvedGraceMs)}.</li>
                <li><strong>Sleeping</strong>: nothing scheduled and no activity for {METERING.windowDays} days. Marked partial when the history seen is shorter than that.</li>
                <li><strong>Active</strong>: none of the above. Checked in that order.</li>
              </ul>
            </details>
            <div className="meter-table-wrap">
              <table className="meter-table">
                <thead><tr><th>Agent</th><th>State</th><th>Why</th><th>Last activity</th></tr></thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.agentId}>
                      <td><button className="link-btn" onClick={() => onOpenAgentHome(a.agentId)}>{a.name}</button></td>
                      <td><span className={`status-chip is-${a.state}`}>{HEALTH_LABEL[a.state]}</span>{a.partial && a.state === 'sleeping' ? ' (so far)' : ''}{a.lastRunFailed ? ' · last run failed' : ''}</td>
                      <td className="wrap">{a.reason}</td>
                      <td>{a.lastActivityAt ? timeAgo(a.lastActivityAt, health.now) : 'none seen'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'pacing' && (
          <div>
            <p className="meter-note">The runner waits {formatSpan(RUNNER_PACING.minDispatchGapMs)} after a dispatch before the next one on the same slot. This is the documented runner setting, not read live. Drain time is arithmetic on the runner’s published jobs: {RUNNER_PACING.baseSlots} slot, {RUNNER_PACING.maxSlots} while {RUNNER_PACING.heavyBacklogJobs}+ jobs are due, each dispatch taking up to {RUNNER_PACING.dispatchTimeoutMs / 1000} s.</p>
            <div className="pace-pair" style={{ marginTop: 10 }}>
              <div className="pace-box">
                <span className="lib-muted">At the current spacing ({formatSpan(current.gapMs)})</span>
                <b>{current.queued === 0 ? 'Nothing queued' : `${formatSpan(current.drainMinMs)} to ${formatSpan(current.drainMaxMs)}`}</b>
                <span className="meter-note">{current.queued} dispatch{current.queued === 1 ? '' : 'es'} waiting ({current.dueJobs} due job{current.dueJobs === 1 ? '' : 's'}, {current.dueCrons} due cron{current.dueCrons === 1 ? '' : 's'}) on {current.slots} slot{current.slots === 1 ? '' : 's'}. {current.neverRunJobs} of {current.totalJobs} jobs have never run.</span>
              </div>
              <div className="pace-box">
                <form className="meter-form" onSubmit={(e) => {
                  e.preventDefault();
                  const e1 = metering.proposeGap(gapMs, gapNote);
                  setErr(e1);
                  if (!e1) setGapNote('');
                }}>
                  <label>Proposed spacing (minutes)<input type="number" min={1} step={1} value={gapMin} onChange={(e) => setGapMin(e.target.value)} aria-describedby="pace-drain" /></label>
                  <label>Why<input value={gapNote} onChange={(e) => setGapNote(e.target.value)} /></label>
                  <button className="btn sm" type="submit">Propose for the Reviewer</button>
                </form>
                <b id="pace-drain">{proposed ? (proposed.queued === 0 ? 'Nothing queued' : `${formatSpan(proposed.drainMinMs)} to ${formatSpan(proposed.drainMaxMs)}`) : 'Enter at least 1 minute'}</b>
                <span className="meter-note">Same queue at the spacing in the box. Recording a proposal changes nothing live: the Reviewer decides, and the runner is changed by hand.</span>
              </div>
            </div>
            <h3 style={{ marginTop: 12 }}>Proposals</h3>
            <div className="meter-table-wrap">
              <table className="meter-table">
                <thead><tr><th>Spacing</th><th>Status</th><th>Why / decision</th></tr></thead>
                <tbody>
                  {metering.state.pacing.length === 0 && <tr><td colSpan={3} className="lib-muted">None yet.</td></tr>}
                  {metering.state.pacing.map((p) => (
                    <tr key={p.id}>
                      <td>{formatSpan(p.gapMs)}</td>
                      <td><span className={`status-chip is-${p.status}`}>{p.status}</span></td>
                      <td className="wrap">
                        {p.decision ? `${p.decision.by}: ${p.decision.note}` : p.note || '—'}
                        {p.status === 'proposed' && <div><DecisionForm id={p.id} onDecide={(d, by, note) => metering.decideGap(p.id, d, by, note)} /></div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
