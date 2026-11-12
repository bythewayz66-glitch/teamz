import { useMemo, useState } from 'react';
import type {
  Agent,
  Approval,
  AuditEntry,
  Connection,
  PolicyDecision,
  PolicyRule,
  Trigger,
  UsageEntry,
  Widget,
} from '../types';
import { CONNECTORS, connectorAccent, connectorGlyph, connectorName } from '../lib/connectors';
import { CRON_PRESETS, describeCron, nextFire, parseCron } from '../lib/cron';
import { DECISION_LABEL, DECISION_TONE, evaluate, groupRules } from '../lib/policy';
import { contextUsage, dailySeries, formatTokens, totalsFor, trendPercent } from '../lib/context';
import { AgentAvatar } from './Avatar';
import { CheckIcon, CloseIcon, PlusIcon, RefreshIcon, TrashIcon } from './Icons';
import { formatRelative, formatTime } from '../lib/format';

/* ------------------------------------------------------------------ helpers */

const TONE_CLASS: Record<'good' | 'warn' | 'bad', string> = {
  good: 'is-good',
  warn: 'is-warn',
  bad: 'is-bad',
};

function DecisionBadge({ decision }: { decision: PolicyDecision | 'info' }) {
  if (decision === 'info') return <span className="badge is-info">info</span>;
  return (
    <span className={`badge ${TONE_CLASS[DECISION_TONE[decision]]}`}>
      {DECISION_LABEL[decision]}
    </span>
  );
}

/** Live "next fire" for a cron trigger, recomputed on every render. */
function NextFire({ cron, enabled }: { cron?: string; enabled: boolean }) {
  const spec = useMemo(() => (cron ? parseCron(cron) : null), [cron]);
  if (!spec) return <span className="muted">invalid cron</span>;
  if (!enabled) return <span className="muted">paused</span>;
  const next = nextFire(spec);
  if (!next) return <span className="muted">never</span>;
  const diffMin = Math.round((next.getTime() - Date.now()) / 60000);
  const when =
    diffMin < 60
      ? `in ${diffMin}m`
      : diffMin < 60 * 24
        ? `in ${Math.round(diffMin / 60)}h`
        : `in ${Math.round(diffMin / 1440)}d`;
  return (
    <span className="next-fire" title={next.toLocaleString()}>
      {when} · {formatTime(next.getTime())}
    </span>
  );
}

/* --------------------------------------------------------------- sub-panels */

function TriggersPanel({
  triggers,
  agentsById,
  onToggle,
  onRunNow,
  onDelete,
  onAdd,
}: {
  triggers: Trigger[];
  agentsById: Map<string, Agent>;
  onToggle: (id: string) => void;
  onRunNow: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: (t: Omit<Trigger, 'id' | 'createdAt' | 'fireCount'>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({
    agentId: '',
    name: '',
    kind: 'cron' as 'cron' | 'webhook',
    cron: CRON_PRESETS[0].cron,
    prompt: '',
  });

  const cronValid = draft.kind === 'webhook' || parseCron(draft.cron) !== null;
  const canAdd = draft.agentId !== '' && draft.name.trim() !== '' && draft.prompt.trim() !== '' && cronValid;

  return (
    <div className="panel-stack">
      <div className="panel-head">
        <div>
          <h3>Scheduled &amp; event triggers</h3>
          <p className="muted">
            A trigger wakes an agent on a schedule or when an external event fires. Next-fire times are
            computed from the cron expression, not stored.
          </p>
        </div>
        <button className="btn primary sm" onClick={() => setAdding((v) => !v)}>
          <PlusIcon size={13} /> New trigger
        </button>
      </div>

      {adding && (
        <div className="card form-card">
          <div className="field-grid">
            <label className="field">
              <span className="field-label">Agent</span>
              <select
                value={draft.agentId}
                onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}
              >
                <option value="">Pick an agent…</option>
                {[...agentsById.values()].map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Name</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Morning lead sweep"
              />
            </label>
          </div>

          <div className="field-grid">
            <label className="field">
              <span className="field-label">Kind</span>
              <div className="seg">
                <button
                  className={draft.kind === 'cron' ? 'is-on' : ''}
                  onClick={() => setDraft({ ...draft, kind: 'cron' })}
                >
                  Schedule
                </button>
                <button
                  className={draft.kind === 'webhook' ? 'is-on' : ''}
                  onClick={() => setDraft({ ...draft, kind: 'webhook' })}
                >
                  Webhook
                </button>
              </div>
            </label>
            {draft.kind === 'cron' && (
              <label className="field">
                <span className="field-label">
                  Cron
                  {!cronValid && <em className="field-error">not a valid 5-field expression</em>}
                </span>
                <input
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                  placeholder="0 8 * * 1-5"
                  spellCheck={false}
                />
                <span className="muted small">
                  {cronValid ? describeCron(parseCron(draft.cron)!) : 'e.g. 0 8 * * 1-5'}
                </span>
              </label>
            )}
          </div>

          {draft.kind === 'cron' && (
            <div className="preset-row">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  className={`chip${draft.cron === p.cron ? ' is-on' : ''}`}
                  onClick={() => setDraft({ ...draft, cron: p.cron })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <label className="field">
            <span className="field-label">Prompt sent to the agent</span>
            <textarea
              value={draft.prompt}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              rows={3}
              placeholder="Sweep the inbound list, score each lead, and post the top five."
            />
          </label>

          <div className="row-end">
            <button className="btn ghost sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button
              className="btn primary sm"
              disabled={!canAdd}
              onClick={() => {
                onAdd({
                  agentId: draft.agentId,
                  name: draft.name.trim(),
                  kind: draft.kind,
                  cron: draft.kind === 'cron' ? draft.cron : undefined,
                  token: draft.kind === 'webhook' ? `whk_${Math.random().toString(36).slice(2, 10)}` : undefined,
                  prompt: draft.prompt.trim(),
                  enabled: true,
                });
                setDraft({ agentId: '', name: '', kind: 'cron', cron: CRON_PRESETS[0].cron, prompt: '' });
                setAdding(false);
              }}
            >
              <CheckIcon size={13} /> Create trigger
            </button>
          </div>
        </div>
      )}

      <ul className="card-list">
        {triggers.map((t) => {
          const agent = agentsById.get(t.agentId);
          const spec = t.cron ? parseCron(t.cron) : null;
          return (
            <li key={t.id} className={`card trigger-card${t.enabled ? '' : ' is-off'}`}>
              <div className="trigger-main">
                <div className="trigger-title">
                  {agent && <AgentAvatar agent={agent} size={26} />}
                  <strong>{t.name}</strong>
                  <span className={`badge ${t.kind === 'cron' ? 'is-info' : 'is-good'}`}>{t.kind}</span>
                  {!t.enabled && <span className="badge is-muted">paused</span>}
                </div>
                <div className="trigger-meta">
                  {t.kind === 'cron' && spec ? (
                    <>
                      <code>{t.cron}</code>
                      <span className="dot-sep">·</span>
                      <span>{describeCron(spec)}</span>
                      <span className="dot-sep">·</span>
                      <NextFire cron={t.cron} enabled={t.enabled} />
                    </>
                  ) : (
                    <>
                      <code>POST /hooks/{t.token}</code>
                      <span className="dot-sep">·</span>
                      <span>{t.fireCount} fires</span>
                    </>
                  )}
                </div>
                <p className="trigger-prompt">{t.prompt}</p>
                <div className="trigger-foot">
                  <span>
                    {t.lastFiredAt ? `Last run ${formatRelative(t.lastFiredAt)} ago` : 'Never run'}
                  </span>
                  <span className="dot-sep">·</span>
                  <span>{t.fireCount} runs</span>
                  {t.lastError && (
                    <>
                      <span className="dot-sep">·</span>
                      <span className="is-bad-text">{t.lastError}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="trigger-actions">
                <button className="btn ghost sm" onClick={() => onRunNow(t.id)} title="Run this trigger now">
                  <RefreshIcon size={13} /> Run now
                </button>
                <button className="btn ghost sm" onClick={() => onToggle(t.id)}>
                  {t.enabled ? 'Pause' : 'Resume'}
                </button>
                <button className="icon-btn ghost danger-hover" onClick={() => onDelete(t.id)} title="Delete trigger">
                  <TrashIcon size={14} />
                </button>
              </div>
            </li>
          );
        })}
        {triggers.length === 0 && <li className="rail-empty">No triggers yet.</li>}
      </ul>
    </div>
  );
}

function ConnectionsPanel({
  connections,
  onConnect,
  onDisconnect,
}: {
  connections: Connection[];
  onConnect: (service: string) => void;
  onDisconnect: (id: string) => void;
}) {
  const byService = new Map(connections.map((c) => [c.service, c]));
  return (
    <div className="panel-stack">
      <div className="panel-head">
        <div>
          <h3>Connected accounts</h3>
          <p className="muted">
            Connect once, then authorize any agent to use the account. Requests are proxied, so an agent
            never sees the token — and every call is checked against the agent’s policy.
          </p>
        </div>
      </div>

      <div className="connector-grid">
        {CONNECTORS.map((c) => {
          const conn = byService.get(c.slug);
          const connected = conn?.status === 'connected';
          const errored = conn?.status === 'error';
          return (
            <div
              key={c.slug}
              className={`connector-tile${connected ? ' is-on' : ''}${errored ? ' is-error' : ''}`}
              style={{ borderColor: connected ? `${c.accent}66` : undefined }}
            >
              <div className="connector-top">
                <span className="connector-glyph" style={{ background: `${c.accent}22`, color: c.accent }}>
                  {c.glyph}
                </span>
                <div className="connector-id">
                  <strong>{c.name}</strong>
                  <span className="muted small">
                    {connected ? conn!.account : errored ? 'needs reconnect' : 'not connected'}
                  </span>
                </div>
              </div>
              <p className="connector-blurb">{c.blurb}</p>
              <div className="connector-scopes">
                {c.scopes.slice(0, 3).map((s) => (
                  <span key={s} className="scope-chip">
                    {s}
                  </span>
                ))}
              </div>
              <div className="connector-foot">
                <span className="muted small">
                  {conn?.lastUsedAt ? `used ${formatRelative(conn.lastUsedAt)} ago` : `${c.actions.length} actions`}
                </span>
                {connected || errored ? (
                  <button className="btn ghost sm" onClick={() => onDisconnect(conn!.id)}>
                    Disconnect
                  </button>
                ) : (
                  <button className="btn primary sm" onClick={() => onConnect(c.slug)}>
                    Connect
                  </button>
                )}
              </div>
              {errored && conn?.error && <p className="connector-error">{conn.error}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PolicyPanel({
  agents,
  policies,
  onSetDecision,
  onAddRule,
  onRemoveRule,
}: {
  agents: Agent[];
  policies: Record<string, PolicyRule[]>;
  onSetDecision: (agentId: string, ruleId: string, decision: PolicyDecision) => void;
  onAddRule: (agentId: string, rule: Omit<PolicyRule, 'id'>) => void;
  onRemoveRule: (agentId: string, ruleId: string) => void;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [probeService, setProbeService] = useState('gmail');
  const [probeAction, setProbeAction] = useState('send');
  const [newRule, setNewRule] = useState({ service: 'gmail', action: 'send', decision: 'review' as PolicyDecision });

  const rules = policies[agentId] ?? [];
  const grouped = useMemo(() => groupRules(rules), [rules]);
  const verdict = useMemo(
    () => evaluate({ service: probeService, action: probeAction }, rules),
    [probeService, probeAction, rules],
  );
  const agent = agents.find((a) => a.id === agentId);

  return (
    <div className="panel-stack">
      <div className="panel-head">
        <div>
          <h3>Policy</h3>
          <p className="muted">
            Rules are enforced in software, not in the prompt. A model cannot talk its way past a block —
            the decision below is computed from the rule set, deterministically.
          </p>
        </div>
        <label className="field inline-field">
          <span className="field-label">Agent</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="card probe-card">
        <div className="probe-head">
          <strong>Test an action</strong>
          <span className="muted small">evaluated live against {agent?.name ?? 'this agent'}’s rules</span>
        </div>
        <div className="probe-row">
          <select value={probeService} onChange={(e) => setProbeService(e.target.value)}>
            {CONNECTORS.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
          <select value={probeAction} onChange={(e) => setProbeAction(e.target.value)}>
            {(CONNECTORS.find((c) => c.slug === probeService)?.actions ?? []).map((a) => (
              <option key={a.action} value={a.action}>
                {a.action} — {a.label}
              </option>
            ))}
          </select>
          <span className={`verdict ${TONE_CLASS[DECISION_TONE[verdict.decision]]}`}>
            {DECISION_LABEL[verdict.decision]}
          </span>
        </div>
        <p className="probe-reason">
          <code>
            {probeService}.{probeAction}
          </code>{' '}
          → {verdict.reason}
          {verdict.ruleId ? ` (rule ${verdict.ruleId})` : ' (agent default)'}
        </p>
      </div>

      <div className="card form-card">
        <div className="probe-head">
          <strong>Add a rule</strong>
        </div>
        <div className="probe-row">
          <select value={newRule.service} onChange={(e) => setNewRule({ ...newRule, service: e.target.value })}>
            <option value="*">* (every service)</option>
            {CONNECTORS.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            value={newRule.action}
            onChange={(e) => setNewRule({ ...newRule, action: e.target.value })}
            placeholder="send · orders.* · *"
            spellCheck={false}
          />
          <div className="seg">
            {(['allow', 'review', 'block'] as PolicyDecision[]).map((d) => (
              <button
                key={d}
                className={newRule.decision === d ? 'is-on' : ''}
                onClick={() => setNewRule({ ...newRule, decision: d })}
              >
                {d}
              </button>
            ))}
          </div>
          <button
            className="btn primary sm"
            disabled={!agentId || newRule.action.trim() === ''}
            onClick={() => {
              onAddRule(agentId, {
                service: newRule.service,
                action: newRule.action.trim(),
                decision: newRule.decision,
              });
              setNewRule({ ...newRule, action: '' });
            }}
          >
            <PlusIcon size={13} /> Add
          </button>
        </div>
      </div>

      {grouped.map((group) => (
        <div key={group.service} className="card policy-group">
          <div className="policy-group-head">
            <span className="connector-glyph sm" style={{ background: `${connectorAccent(group.service)}22`, color: connectorAccent(group.service) }}>
              {group.service === '*' ? '✳️' : connectorGlyph(group.service)}
            </span>
            <strong>{group.service === '*' ? 'Every service' : connectorName(group.service)}</strong>
            <span className="muted small">{group.rules.length} rules</span>
          </div>
          <ul className="rule-list">
            {group.rules.map((r) => (
              <li key={r.id} className="rule-row">
                <code className="rule-action">
                  {r.service}.{r.action}
                </code>
                <span className="rule-note">{r.note ?? ''}</span>
                <div className="seg tiny">
                  {(['allow', 'review', 'block'] as PolicyDecision[]).map((d) => (
                    <button
                      key={d}
                      className={r.decision === d ? 'is-on' : ''}
                      onClick={() => onSetDecision(agentId, r.id, d)}
                      title={`Set to ${d}`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
                <button
                  className="icon-btn ghost danger-hover"
                  onClick={() => onRemoveRule(agentId, r.id)}
                  title="Remove rule"
                >
                  <CloseIcon size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function AuditPanel({
  audit,
  agentsById,
  approvals,
  onDecide,
}: {
  audit: AuditEntry[];
  agentsById: Map<string, Agent>;
  approvals: Approval[];
  onDecide: (id: string, approve: boolean) => void;
}) {
  const [filter, setFilter] = useState<'all' | PolicyDecision | 'info'>('all');
  const rows = filter === 'all' ? audit : audit.filter((e) => e.decision === filter);
  const pending = approvals.filter((a) => a.status === 'pending');

  return (
    <div className="panel-stack">
      <div className="panel-head">
        <div>
          <h3>Approvals &amp; audit trail</h3>
          <p className="muted">
            Every action an agent proposes lands here with the decision that was applied — what it did,
            when, and under which rule.
          </p>
        </div>
        <div className="seg">
          {(['all', 'allow', 'review', 'block', 'info'] as const).map((f) => (
            <button key={f} className={filter === f ? 'is-on' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card approval-card">
          <div className="probe-head">
            <strong>Waiting for you</strong>
            <span className="badge is-warn">{pending.length}</span>
          </div>
          <ul className="approval-list">
            {pending.map((a) => {
              const agent = agentsById.get(a.agentId);
              return (
                <li key={a.id} className="approval-row">
                  {agent && <AgentAvatar agent={agent} size={28} />}
                  <div className="approval-text">
                    <strong>{a.action.summary}</strong>
                    <span className="muted small">
                      {agent?.name ?? 'Agent'} · <code>{a.action.service}.{a.action.action}</code> ·{' '}
                      {a.verdict.reason}
                    </span>
                  </div>
                  <div className="approval-actions">
                    <button className="btn ghost sm" onClick={() => onDecide(a.id, false)}>
                      Deny
                    </button>
                    <button className="btn primary sm" onClick={() => onDecide(a.id, true)}>
                      Approve
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <ul className="card-list audit-list">
        {rows.map((e) => {
          const agent = e.agentId ? agentsById.get(e.agentId) : undefined;
          return (
            <li key={e.id} className="audit-row">
              <span className="audit-time">{formatTime(e.at)}</span>
              <span className="audit-agent">{agent?.name ?? 'system'}</span>
              <code className="audit-action">{e.action}</code>
              <DecisionBadge decision={e.decision} />
              <span className="audit-detail">{e.detail}</span>
              {e.executed && <span className="badge is-muted">executed</span>}
            </li>
          );
        })}
        {rows.length === 0 && <li className="rail-empty">Nothing logged for this filter.</li>}
      </ul>
    </div>
  );
}

function UsagePanel({
  agents,
  usage,
  widgets,
  agentsById,
}: {
  agents: Agent[];
  usage: UsageEntry[];
  widgets: Widget[];
  agentsById: Map<string, Agent>;
}) {
  const [agentId, setAgentId] = useState<string>('');
  const totals = totalsFor(usage, agentId || undefined);
  const series = dailySeries(usage, 7, agentId || undefined);
  const trend = trendPercent(usage, 7, agentId || undefined);
  const peak = Math.max(1, ...series.map((s) => s.tokens));
  const agentWidgets = widgets.filter((w) => !agentId || w.agentId === agentId);

  return (
    <div className="panel-stack">
      <div className="panel-head">
        <div>
          <h3>Usage &amp; widgets</h3>
          <p className="muted">
            Token spend per agent per day, and the widgets agents have published into the workspace.
          </p>
        </div>
        <label className="field inline-field">
          <span className="field-label">Agent</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="stat-row">
        <div className="stat">
          <strong>{formatTokens(totals.totalTokens)}</strong>
          <span>tokens · 7d</span>
        </div>
        <div className="stat">
          <strong>{totals.runs}</strong>
          <span>runs</span>
        </div>
        <div className="stat">
          <strong>{formatTokens(totals.promptTokens)}</strong>
          <span>prompt</span>
        </div>
        <div className="stat">
          <strong className={trend === null ? '' : trend > 0 ? 'is-bad-text' : 'is-good-text'}>
            {trend === null ? '—' : `${trend > 0 ? '+' : ''}${trend}%`}
          </strong>
          <span>vs prior 7d</span>
        </div>
      </div>

      <div className="card">
        <div className="probe-head">
          <strong>Daily tokens</strong>
          <span className="muted small">last 7 days</span>
        </div>
        <div className="spark">
          {series.map((s) => (
            <div key={s.day} className="spark-col" title={`${s.day}: ${formatTokens(s.tokens)} tokens`}>
              <div className="spark-bar" style={{ height: `${Math.max(2, (s.tokens / peak) * 100)}%` }} />
              <span className="spark-label">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="widget-grid">
        {agentWidgets.map((w) => (
          <WidgetCard key={w.id} widget={w} agent={agentsById.get(w.agentId)} />
        ))}
        {agentWidgets.length === 0 && <p className="rail-empty">No widgets published yet.</p>}
      </div>
    </div>
  );
}

/** Renders one published widget. Every kind is a real layout, not a placeholder. */
export function WidgetCard({ widget, agent }: { widget: Widget; agent?: Agent }) {
  return (
    <div className="card widget-card">
      <div className="widget-head">
        <div>
          <strong>{widget.title}</strong>
          {widget.caption && <span className="muted small">{widget.caption}</span>}
        </div>
        {agent && <AgentAvatar agent={agent} size={22} />}
      </div>

      {widget.kind === 'metric' && (
        <div className="metric-grid">
          {(widget.metrics ?? []).map((m) => (
            <div key={m.label} className="metric">
              <span className="metric-value">{m.value}</span>
              <span className="metric-label">{m.label}</span>
              {m.delta && <span className={`metric-delta ${m.tone ? TONE_CLASS[m.tone] : ''}`}>{m.delta}</span>}
            </div>
          ))}
        </div>
      )}

      {widget.kind === 'bars' && (
        <ul className="bar-list">
          {(widget.bars ?? []).map((b) => {
            const max = Math.max(1, ...(widget.bars ?? []).map((x) => x.value));
            return (
              <li key={b.label} className="bar-row">
                <span className="bar-label">{b.label}</span>
                <span className="bar-track">
                  <span
                    className={`bar-fill ${b.tone ? TONE_CLASS[b.tone] : ''}`}
                    style={{ width: `${(b.value / max) * 100}%` }}
                  />
                </span>
                <span className="bar-caption">{b.caption ?? b.value}</span>
              </li>
            );
          })}
        </ul>
      )}

      {widget.kind === 'table' && (
        <table className="widget-table">
          <thead>
            <tr>
              {(widget.columns ?? []).map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(widget.rows ?? []).map((r, i) => (
              <tr key={i} className={r.tone ? TONE_CLASS[r.tone] : ''}>
                {r.cells.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {widget.kind === 'list' && (
        <ul className="widget-list">
          {(widget.rows ?? []).map((r, i) => (
            <li key={i} className={r.tone ? TONE_CLASS[r.tone] : ''}>
              <strong>{r.cells[0]}</strong>
              <span className="muted small">{r.cells.slice(1).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}

      {widget.kind === 'progress' && (
        <div className="progress-wrap">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${Math.round((widget.progress ?? 0) * 100)}%` }} />
          </div>
          <span className="muted small">{Math.round((widget.progress ?? 0) * 100)}%</span>
        </div>
      )}

      <div className="widget-foot muted small">updated {formatRelative(widget.updatedAt)} ago</div>
    </div>
  );
}

/* ------------------------------------------------------------------- panel */

export type AutomationsTab = 'triggers' | 'connections' | 'policy' | 'audit' | 'usage';

export interface AutomationsProps {
  agents: Agent[];
  agentsById: Map<string, Agent>;
  triggers: Trigger[];
  connections: Connection[];
  policies: Record<string, PolicyRule[]>;
  audit: AuditEntry[];
  approvals: Approval[];
  usage: UsageEntry[];
  widgets: Widget[];
  /** Messages of the active conversation, for the context meter. */
  contextMessages: { text: string }[];
  onToggleTrigger: (id: string) => void;
  onRunTrigger: (id: string) => void;
  onDeleteTrigger: (id: string) => void;
  onAddTrigger: (t: Omit<Trigger, 'id' | 'createdAt' | 'fireCount'>) => void;
  onConnect: (service: string) => void;
  onDisconnect: (id: string) => void;
  onSetDecision: (agentId: string, ruleId: string, decision: PolicyDecision) => void;
  onAddRule: (agentId: string, rule: Omit<PolicyRule, 'id'>) => void;
  onRemoveRule: (agentId: string, ruleId: string) => void;
  onDecideApproval: (id: string, approve: boolean) => void;
}

const TABS: { id: AutomationsTab; label: string }[] = [
  { id: 'triggers', label: 'Triggers' },
  { id: 'connections', label: 'Connections' },
  { id: 'policy', label: 'Policy' },
  { id: 'audit', label: 'Audit' },
  { id: 'usage', label: 'Usage' },
];

export function Automations(props: AutomationsProps) {
  const [tab, setTab] = useState<AutomationsTab>('triggers');
  const ctx = contextUsage(props.contextMessages as never);
  const pendingCount = props.approvals.filter((a) => a.status === 'pending').length;

  return (
    <div className="automations">
      <header className="automations-head">
        <div>
          <h2>Automations</h2>
          <p className="muted">
            Triggers, connected accounts, policy, the audit trail and usage — the parts of the workspace
            that keep running when nobody is watching.
          </p>
        </div>
        <div className="context-meter" title={`${ctx.used} of ${ctx.total} tokens in this conversation`}>
          <span className="muted small">Context usage</span>
          <div className="context-track">
            <div className={`context-fill is-${ctx.level}`} style={{ width: `${Math.max(2, ctx.ratio * 100)}%` }} />
          </div>
          <span className="context-label">{ctx.label}</span>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab${tab === t.id ? ' is-on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'audit' && pendingCount > 0 && <span className="tab-count">{pendingCount}</span>}
          </button>
        ))}
      </nav>

      {tab === 'triggers' && (
        <TriggersPanel
          triggers={props.triggers}
          agentsById={props.agentsById}
          onToggle={props.onToggleTrigger}
          onRunNow={props.onRunTrigger}
          onDelete={props.onDeleteTrigger}
          onAdd={props.onAddTrigger}
        />
      )}
      {tab === 'connections' && (
        <ConnectionsPanel
          connections={props.connections}
          onConnect={props.onConnect}
          onDisconnect={props.onDisconnect}
        />
      )}
      {tab === 'policy' && (
        <PolicyPanel
          agents={props.agents}
          policies={props.policies}
          onSetDecision={props.onSetDecision}
          onAddRule={props.onAddRule}
          onRemoveRule={props.onRemoveRule}
        />
      )}
      {tab === 'audit' && (
        <AuditPanel
          audit={props.audit}
          agentsById={props.agentsById}
          approvals={props.approvals}
          onDecide={props.onDecideApproval}
        />
      )}
      {tab === 'usage' && (
        <UsagePanel
          agents={props.agents}
          usage={props.usage}
          widgets={props.widgets}
          agentsById={props.agentsById}
        />
      )}
    </div>
  );
}
