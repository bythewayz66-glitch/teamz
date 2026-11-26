/**
 * JobsPanel — jobs, schedules, triggers, and the approvals queue.
 *
 * Rendered as a modal over the chat, reusing the existing Modal/Field
 * primitives and button styles (no new CSS). Three sections:
 *
 *  - Approvals: the queue Jesse decides. A gated stage cannot run until
 *    its request is approved here; denying it blocks the stage until a
 *    new request is made.
 *  - Jobs: product-loop jobs with their current stage, per-stage agent
 *    assignment, run history with provenance (which run produced which
 *    output, when, in which channel), and Run now / pause / resume.
 *  - Schedules: interval triggers and cron jobs with enable/disable.
 *
 * The panel also states the honest 24/7 limit up front: this in-tab
 * runner fires only while the tab is open. The server runner on jnet1 is
 * the one that runs around the clock — see README → "Autonomy".
 */

import { useMemo, useState } from 'react';
import type { Agent, Conversation } from '../types';
import { Modal, Field } from './Modal';
import { formatRelative, formatTime } from '../lib/format';
import { nextRun } from '../lib/scheduler';
import { pendingApprovals } from '../lib/governance';
import type { JobStage } from '../lib/jobs';
import type { UseAutonomy } from '../store/useAutonomy';

interface JobsPanelProps {
  open: boolean;
  onClose: () => void;
  autonomy: UseAutonomy;
  agents: Agent[];
  conversations: Conversation[];
  onOpenConversation: (id: string) => void;
}

function scheduleLabel(job: { schedule: { kind: string; expr?: string; everyMs?: number } }): string {
  const s = job.schedule;
  if (s.kind === 'manual') return 'manual (Run now)';
  if (s.kind === 'interval') return `every ${Math.round((s.everyMs ?? 0) / 60000)} min`;
  return `cron ${s.expr ?? ''}`;
}

/**
 * Selects have no theme rule (nothing else in the app uses one), and
 * styles.css is out of scope for this work — so the panel styles them
 * inline to match `.field input` instead of showing a default light box.
 */
const SELECT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 10,
  background: '#0b1017',
  border: '1px solid #1f2836',
  outline: 0,
  fontSize: 13,
  color: '#e9edf5',
};

export function JobsPanel({
  open,
  onClose,
  autonomy,
  agents,
  conversations,
  onOpenConversation,
}: JobsPanelProps) {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [tplKind, setTplKind] = useState<'ship-release' | 'publish-docs' | 'repo-check'>('ship-release');
  const [tplName, setTplName] = useState('');
  const [tplChannelId, setTplChannelId] = useState('');
  const [tplAgentId, setTplAgentId] = useState('');
  const [tplWorkdir, setTplWorkdir] = useState('/opt/mem20');
  const [tplError, setTplError] = useState<string | null>(null);

  const [trgChannelId, setTrgChannelId] = useState('');
  const [trgAgentId, setTrgAgentId] = useState('');
  const [trgPrompt, setTrgPrompt] = useState('');
  const [trgMinutes, setTrgMinutes] = useState('60');
  const [trgError, setTrgError] = useState<string | null>(null);

  const [cronName, setCronName] = useState('');
  const [cronExpr, setCronExpr] = useState('0 7 * * 1-5');
  const [cronAgentId, setCronAgentId] = useState('');
  const [cronChannelId, setCronChannelId] = useState('');
  const [cronTarget, setCronTarget] = useState('');
  const [cronError, setCronError] = useState<string | null>(null);

  const pending = useMemo(() => pendingApprovals(autonomy.approvals), [autonomy.approvals]);
  const decided = useMemo(
    () => autonomy.approvals.filter((a) => a.status !== 'pending').slice(-5).reverse(),
    [autonomy.approvals],
  );

  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const channelName = (id: string) => conversations.find((c) => c.id === id)?.name ?? id;

  const createFromTemplate = () => {
    setTplError(null);
    if (!tplChannelId || !tplAgentId) {
      setTplError('Pick a channel and an agent first.');
      return;
    }
    if (tplKind === 'repo-check' && !tplWorkdir.trim()) {
      setTplError('A repo check needs the working directory of the checked-out repo.');
      return;
    }
    try {
      autonomy.addJobFromTemplate(tplKind, {
        name: tplName.trim() || undefined,
        channelId: tplChannelId,
        agentId: tplAgentId,
        workdir: tplKind === 'repo-check' ? tplWorkdir.trim() : undefined,
      });
      setTplName('');
    } catch (err) {
      setTplError(err instanceof Error ? err.message : 'Could not create the job.');
    }
  };

  const createTrigger = () => {
    setTrgError(null);
    const minutes = Number(trgMinutes);
    if (!trgChannelId || !trgAgentId || !trgPrompt.trim() || !Number.isFinite(minutes) || minutes < 1) {
      setTrgError('Pick a channel and an agent, write a prompt, and set an interval of at least 1 minute.');
      return;
    }
    try {
      autonomy.addTrigger({
        channelId: trgChannelId,
        agentId: trgAgentId,
        prompt: trgPrompt.trim(),
        everyMs: Math.floor(minutes * 60000),
      });
      setTrgPrompt('');
    } catch (err) {
      setTrgError(err instanceof Error ? err.message : 'Could not create the trigger.');
    }
  };

  const createCronJob = () => {
    setCronError(null);
    if (!cronName.trim() || !cronAgentId || !cronChannelId || !cronTarget.trim()) {
      setCronError('Fill in a name, a schedule, an agent, a channel, and the prompt.');
      return;
    }
    try {
      autonomy.addCronJob({
        name: cronName.trim(),
        schedule: cronExpr.trim(),
        target: cronTarget.trim(),
        agentId: cronAgentId,
        channelId: cronChannelId,
      });
      setCronName('');
      setCronTarget('');
    } catch (err) {
      setCronError(err instanceof Error ? err.message : 'Could not create the cron job.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Jobs & Scheduler"
      subtitle="Autonomous product loop, schedules, and Jesse's approval queue."
      width={720}
    >
      <div className="info-block" style={{ marginBottom: 16 }}>
        <h3>Runs while this tab is open</h3>
        <p>
          This runner checks for due work every 30 seconds and fires it through the chat — but only
          while this tab is open. Close the tab (or let the browser throttle a background tab) and
          nothing runs. True 24/7 runs on the server runner on jnet1; see README → “Autonomy”.
        </p>
        <p className="muted">
          When a run fires, the panel switches to that job’s channel to deliver it — the run belongs
          in that channel’s history, which is its provenance record.
        </p>
      </div>

      <div className="info-block" style={{ marginBottom: 16 }}>
        <h3>Approvals — Jesse decides {pending.length > 0 && `(${pending.length} waiting)`}</h3>
        {pending.length === 0 && <p className="muted">Nothing waiting. Release, advertise, sell — and anything that spends money or publishes publicly — will appear here before it can run.</p>}
        {pending.map((req) => (
          <div key={req.id} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border, #242f40)' }}>
            <p>
              <strong>{req.jobName}</strong> — stage <strong>{req.stage}</strong>
            </p>
            <p className="muted">{req.reason}</p>
            <p className="muted">Requested {formatRelative(req.requestedAt)}.</p>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn primary sm" onClick={() => autonomy.approve(req.id)}>
                Approve
              </button>
              <button className="btn danger sm" onClick={() => autonomy.deny(req.id)}>
                Deny
              </button>
            </div>
          </div>
        ))}
        {decided.length > 0 && (
          <p className="muted" style={{ marginTop: 10 }}>
            Recently decided:{' '}
            {decided.map((a) => `${a.jobName} / ${a.stage}: ${a.status}`).join(' · ')}
          </p>
        )}
      </div>

      <div className="info-block" style={{ marginBottom: 16 }}>
        <h3>Product jobs ({autonomy.jobs.length})</h3>
        {autonomy.jobs.length === 0 && (
          <p className="muted">No jobs yet. Create one from a template below — the “ship a release” chain walks design → build → implement → upgrade → release → document → advertise → sell.</p>
        )}
        {autonomy.jobs.map((job) => {
          const current = job.stages[job.currentStageIndex];
          const expanded = expandedJobId === job.id;
          return (
            <div key={job.id} style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border, #242f40)' }}>
              <p>
                <strong>{job.name}</strong>{' '}
                <span className="muted">
                  · {job.status}
                  {current ? ` · stage ${job.currentStageIndex + 1}/${job.stages.length}: ${current.stage}` : ' · done'}
                  {' · '}{scheduleLabel(job)}
                  {job.enabled ? '' : ' · disabled'}
                </span>
              </p>
              <p className="muted">
                Channel: {channelName(job.channelId)}
                {job.managerAgentId ? ` · manager: ${agentName(job.managerAgentId)}` : ''}
                {job.workdir ? ` · workdir: ${job.workdir}` : ''}
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn primary sm"
                  onClick={() => autonomy.runJobNow(job.id)}
                  disabled={job.status === 'done' || !job.enabled}
                >
                  Run now
                </button>
                {job.status === 'paused' ? (
                  <button className="btn ghost sm" onClick={() => autonomy.resumeJob(job.id)}>Resume</button>
                ) : (
                  <button className="btn ghost sm" onClick={() => autonomy.pauseJob(job.id)} disabled={job.status === 'done'}>Pause</button>
                )}
                <button
                  className="btn ghost sm"
                  onClick={() => autonomy.setJobEnabled(job.id, !job.enabled)}
                >
                  {job.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn ghost sm" onClick={() => setExpandedJobId(expanded ? null : job.id)}>
                  {expanded ? 'Hide detail' : 'Detail'}
                </button>
                <button className="btn ghost sm danger-hover" onClick={() => autonomy.deleteJob(job.id)}>
                  Delete
                </button>
              </div>
              {expanded && (
                <div style={{ marginTop: 10 }}>
                  <p className="muted">Stages — reassign an agent per stage:</p>
                  {job.stages.map((st, i) => (
                    <div key={st.stage} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
                      <span style={{ minWidth: 92 }}>
                        {i + 1}. {st.stage}
                        {st.humanInput ? ' (approval)' : ''}
                        {st.command ? ` (command: ${st.command.argv.join(' ')})` : ''}
                      </span>
                      <select style={SELECT_STYLE}
                        value={st.agentId}
                        onChange={(e) => autonomy.setStageAgent(job.id, st.stage as JobStage, e.target.value)}
                        disabled={i < job.currentStageIndex}
                        aria-label={`Agent for ${st.stage} stage`}
                      >
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                  <p className="muted" style={{ marginTop: 10 }}>Run history — which run produced which output, when:</p>
                  {job.runs.length === 0 && <p className="muted">No runs yet.</p>}
                  {job.runs.slice(-5).reverse().map((run) => (
                    <p key={run.id} className="muted" style={{ marginTop: 6 }}>
                      {formatTime(run.startedAt)} · {run.stage} · {run.agentId ? agentName(run.agentId) : ''} ·{' '}
                      {run.status}
                      {run.output ? ` — “${run.output.slice(0, 120)}${run.output.length > 120 ? '…' : ''}”` : ''}
                      {' · '}
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          onOpenConversation(run.conversationId);
                          onClose();
                        }}
                      >
                        View in channel
                      </button>
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--border, #242f40)' }}>
          <p><strong>New job from a template</strong></p>
          <div className="field-grid">
            <Field label="Template">
              <select style={SELECT_STYLE} value={tplKind} onChange={(e) => setTplKind(e.target.value as typeof tplKind)}>
                <option value="ship-release">Ship a release (full 8-stage loop)</option>
                <option value="publish-docs">Publish docs (design → document)</option>
                <option value="repo-check">Nightly repo check (command stage)</option>
              </select>
            </Field>
            <Field label="Name (optional)">
              <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="e.g. mem20 v4.1 release" />
            </Field>
            <Field label="Channel">
              <select style={SELECT_STYLE} value={tplChannelId} onChange={(e) => setTplChannelId(e.target.value)}>
                <option value="">Pick a channel…</option>
                {conversations.filter((c) => c.kind === 'channel').map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Agent (every stage, reassignable later)">
              <select style={SELECT_STYLE} value={tplAgentId} onChange={(e) => setTplAgentId(e.target.value)}>
                <option value="">Pick an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
            {tplKind === 'repo-check' && (
              <Field label="Repo working directory (on the server runner)">
                <input value={tplWorkdir} onChange={(e) => setTplWorkdir(e.target.value)} />
              </Field>
            )}
          </div>
          {tplError && <p className="field-error">{tplError}</p>}
          <div style={{ marginTop: 10 }}>
            <button className="btn primary sm" onClick={createFromTemplate}>Create job</button>
          </div>
        </div>
      </div>

      <div className="info-block" style={{ marginBottom: 16 }}>
        <h3>Interval triggers ({autonomy.triggers.length})</h3>
        {autonomy.triggers.length === 0 && <p className="muted">No triggers yet. A trigger sends a prompt to one agent in one channel every N minutes.</p>}
        {autonomy.triggers.map((t) => (
          <p key={t.id} className="muted" style={{ marginTop: 8 }}>
            “{t.prompt.slice(0, 80)}” → {agentName(t.agentId)} in {channelName(t.channelId)} · every{' '}
            {Math.round(t.everyMs / 60000)} min · last run{' '}
            {t.lastRunAt == null ? 'never' : formatRelative(t.lastRunAt)}
            {' · '}
            <button className="btn ghost sm" onClick={() => autonomy.setTriggerEnabled(t.id, !t.enabled)}>
              {t.enabled ? 'Disable' : 'Enable'}
            </button>{' '}
            <button className="btn ghost sm danger-hover" onClick={() => autonomy.deleteTrigger(t.id)}>Delete</button>
          </p>
        ))}
        <div style={{ marginTop: 10 }}>
          <div className="field-grid">
            <Field label="Channel">
              <select style={SELECT_STYLE} value={trgChannelId} onChange={(e) => setTrgChannelId(e.target.value)}>
                <option value="">Pick a channel…</option>
                {conversations.filter((c) => c.kind === 'channel').map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Agent">
              <select style={SELECT_STYLE} value={trgAgentId} onChange={(e) => setTrgAgentId(e.target.value)}>
                <option value="">Pick an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Prompt">
              <input value={trgPrompt} onChange={(e) => setTrgPrompt(e.target.value)} placeholder="What should the agent do?" />
            </Field>
            <Field label="Every (minutes)">
              <input value={trgMinutes} onChange={(e) => setTrgMinutes(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          {trgError && <p className="field-error">{trgError}</p>}
          <div style={{ marginTop: 10 }}>
            <button className="btn primary sm" onClick={createTrigger}>Add trigger</button>
          </div>
        </div>
      </div>

      <div className="info-block">
        <h3>Cron jobs ({autonomy.cronJobs.length})</h3>
        {autonomy.cronJobs.length === 0 && <p className="muted">No cron jobs yet. A cron job sends a prompt on a cron schedule (minute hour day month weekday).</p>}
        {autonomy.cronJobs.map((j) => {
          let next: string = '—';
          try {
            next = formatRelative(nextRun(j).getTime());
          } catch {
            next = 'invalid schedule';
          }
          return (
            <p key={j.id} className="muted" style={{ marginTop: 8 }}>
              <strong>{j.name}</strong> · <code>{j.schedule}</code> · next {next} ·{' '}
              {agentName(j.agentId ?? '')} in {channelName(j.channelId ?? '')} ·{' '}
              {j.runs.length > 0 ? `last run ${formatRelative(j.runs[j.runs.length - 1].ts)} (${j.runs[j.runs.length - 1].ok ? 'ok' : 'failed'})` : 'never run'}
              {' · '}
              <button className="btn ghost sm" onClick={() => autonomy.setCronJobEnabled(j.id, !j.enabled)}>
                {j.enabled ? 'Disable' : 'Enable'}
              </button>{' '}
              <button className="btn ghost sm danger-hover" onClick={() => autonomy.deleteCronJob(j.id)}>Delete</button>
            </p>
          );
        })}
        <div style={{ marginTop: 10 }}>
          <div className="field-grid">
            <Field label="Name">
              <input value={cronName} onChange={(e) => setCronName(e.target.value)} placeholder="Morning brief" />
            </Field>
            <Field label="Cron schedule">
              <input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} placeholder="0 7 * * 1-5" />
            </Field>
            <Field label="Agent">
              <select style={SELECT_STYLE} value={cronAgentId} onChange={(e) => setCronAgentId(e.target.value)}>
                <option value="">Pick an agent…</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Channel">
              <select style={SELECT_STYLE} value={cronChannelId} onChange={(e) => setCronChannelId(e.target.value)}>
                <option value="">Pick a channel…</option>
                {conversations.filter((c) => c.kind === 'channel').map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Prompt">
              <input value={cronTarget} onChange={(e) => setCronTarget(e.target.value)} placeholder="What should the agent do?" />
            </Field>
          </div>
          {cronError && <p className="field-error">{cronError}</p>}
          <div style={{ marginTop: 10 }}>
            <button className="btn primary sm" onClick={createCronJob}>Add cron job</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
