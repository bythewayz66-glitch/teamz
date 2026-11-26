import { useEffect, useState } from 'react';
import type { Agent, AgentSkill, AgentStatus, TemplateCategory } from '../types';
import { Modal, Field } from './Modal';
import { AgentAvatar } from './Avatar';
import { CheckIcon, RefreshIcon, TrashIcon } from './Icons';
import { ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';
import { pingAgent } from '../api/agents';
import { getSettings } from '../api/settings';
import { formatRelative } from '../lib/format';
import { SkillPicker } from './SkillPicker';
import {
  formatSkillGuidance,
  skillsMissingFromPrompt,
  type SkillGuidance,
} from '../lib/agentPrompt';
import { getSkillByKey, CATEGORY_ORDER } from '../data/templates';

function parseBudget(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Convert registry keys to the agent's skill list. Registry skills resolve
 * to their real name; legacy keys that predate the registry (the seed agents
 * carry bare keys like `research`) are kept as name-only skills rather than
 * dropped, so editing an old agent never silently loses its skills.
 */
function agentSkillsFromKeys(keys: string[]): AgentSkill[] {
  return keys.map((key, index) => {
    try {
      const skill = getSkillByKey(key);
      return { key, label: skill.name, level: Math.max(2, 5 - Math.floor(index * 0.7)) };
    } catch {
      const raw = key.split('.').pop() ?? key;
      const label = raw.replace(/-/g, ' ');
      return { key, label: label.charAt(0).toUpperCase() + label.slice(1), level: 4 };
    }
  });
}

/** What an agent's skills contribute to a prompt — name plus real guidance. */
function skillGuidanceFromAgentSkills(skills: AgentSkill[]): SkillGuidance[] {
  return skills.map((skill) => {
    try {
      const resolved = getSkillByKey(skill.key);
      return { name: resolved.name, description: resolved.description };
    } catch {
      return { name: skill.label };
    }
  });
}

interface AgentSettingsProps {
  agent: Agent | null;
  onClose: () => void;
  onSave: (id: string, patch: Partial<Agent>) => void;
  onDelete: (id: string) => void;
  onOpenChat: (id: string) => void;
}

const STATUSES: AgentStatus[] = ['online', 'busy', 'offline'];

function validateEndpoint(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return 'Enter a valid URL (e.g. http://localhost:8001/chat).';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'URL must start with http:// or https://.';
  }
  if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.protocol === 'http:') {
    return 'Mixed content: an https page cannot call an http endpoint.';
  }
  return null;
}

export function AgentSettings({ agent, onClose, onSave, onDelete, onOpenChat }: AgentSettingsProps) {
  const [draft, setDraft] = useState<Agent | null>(agent);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Budget inputs keep their own text so typing an in-between value (e.g.
  // clearing the field to retype) never fights the numeric draft value.
  const [maxIterText, setMaxIterText] = useState('');
  const [maxExecText, setMaxExecText] = useState('');

  useEffect(() => {
    setDraft(agent);
    setConfirmDelete(false);
    setMaxIterText(agent?.maxIterations !== undefined ? String(agent.maxIterations) : '');
    setMaxExecText(
      agent?.maxExecutionTimeSeconds !== undefined ? String(agent.maxExecutionTimeSeconds) : '',
    );
    if (agent?.lastPingAt) {
      setTestResult({
        ok: agent.lastPingOk ?? false,
        message: agent.lastPingMessage ?? '',
        latencyMs: 0,
      });
    } else {
      setTestResult(null);
    }
  }, [agent]);

  if (!draft) return null;

  const dirty = agent !== null && JSON.stringify(draft) !== JSON.stringify(agent);

  const patch = (p: Partial<Agent>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = () => {
    onSave(draft.id, {
      name: draft.name.trim() || 'Untitled Agent',
      emoji: draft.emoji,
      accent: draft.accent,
      status: draft.status,
      endpointUrl: draft.endpointUrl.trim(),
      model: draft.model.trim(),
      systemPrompt: draft.systemPrompt,
      skills: draft.skills,
      maxIterations: draft.maxIterations,
      maxExecutionTimeSeconds: draft.maxExecutionTimeSeconds,
    });
    onClose();
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    const result = await pingAgent(draft);
    setTestResult(result);
    setTesting(false);
    const pingPatch = {
      lastPingAt: Date.now(),
      lastPingOk: result.ok,
      lastPingMessage: result.message,
    };
    setDraft((d) => (d ? { ...d, ...pingPatch } : d));
    onSave(draft.id, pingPatch);
  };

  const nameError = draft.name.trim() === '' ? 'Name is required.' : null;
  const modelError = draft.model.trim() === '' ? 'Model is required.' : null;
  const endpointError = validateEndpoint(draft.endpointUrl);
  const canSave = !nameError && !modelError && !endpointError;

  // Skills whose guidance is not already in the prompt — what the
  // "add guidance" button below would append. Nothing is rewritten
  // automatically: the user decides when the prompt changes.
  const missingGuidance = skillsMissingFromPrompt(
    draft.systemPrompt,
    skillGuidanceFromAgentSkills(draft.skills),
  );

  const appendSkillGuidance = () => {
    const guidance = formatSkillGuidance(missingGuidance);
    if (!guidance) return;
    const separator = draft.systemPrompt.trim() === '' ? '' : '\n\n';
    patch({ systemPrompt: `${draft.systemPrompt}${separator}${guidance}` });
  };

  return (
    <Modal
      open={Boolean(agent)}
      onClose={onClose}
      title="Agent settings"
      subtitle="Point this agent at a model running on your own server."
      width={560}
      footer={
        <>
          <div className="foot-left">
            {confirmDelete ? (
              <div className="confirm-inline">
                <span>Delete this agent? Their direct chat and any channel they’re the last member of will be removed.</span>
                <button className="btn danger sm" onClick={() => onDelete(draft.id)}>
                  Yes, delete
                </button>
                <button className="btn ghost sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn ghost sm danger-hover" onClick={() => setConfirmDelete(true)}>
                <TrashIcon size={14} /> Delete
              </button>
            )}
          </div>
          <div className="foot-right">
            <button className="btn ghost sm" onClick={() => { onOpenChat(draft.id); onClose(); }}>
              Open chat
            </button>
            <button className="btn primary sm" onClick={save} disabled={!dirty || !canSave}>
              <CheckIcon size={14} /> Save changes
            </button>
          </div>
        </>
      }
    >
      <div className="settings-preview">
        <AgentAvatar agent={draft} size={56} showStatus={draft.status} />
        <div>
          <strong>{draft.name || 'Untitled Agent'}</strong>
          <span>
            {draft.origin ? `${draft.origin.role} · ` : ''}
            Created {formatRelative(draft.createdAt)} ago · {draft.model || 'no model set'}
          </span>
        </div>
      </div>

      {/* --- identity (create-skills workstream): read-only self-model, stored at creation. --- */}
      {(draft.role || draft.goal) && (
        <div className="field">
          <span className="field-label">
            Identity
            <em>role, goal and backstory from creation — the prompt is edited below</em>
          </span>
          <span className="tpl-card-desc">
            {draft.role ? `${draft.role}` : 'No role recorded'}
            {draft.goal ? ` — ${draft.goal}` : ''}
          </span>
        </div>
      )}

      {/* --- skills (create-skills workstream): editable picker, not read-only chips. --- */}
      <div className="field">
        <span className="field-label">
          Skills
          <em>{draft.origin ? `from ${draft.origin.templateId}` : 'set by hand'}</em>
        </span>
        <SkillPicker
          selectedKeys={draft.skills.map((s) => s.key)}
          onChange={(keys) => patch({ skills: agentSkillsFromKeys(keys) })}
          focusCategory={
            draft.origin &&
            (CATEGORY_ORDER as readonly string[]).includes(draft.origin.familySlug)
              ? (draft.origin.familySlug as TemplateCategory)
              : undefined
          }
        />
        <div className="test-row">
          <button
            className="btn ghost sm"
            onClick={appendSkillGuidance}
            disabled={missingGuidance.length === 0}
          >
            Add skill guidance to system prompt
          </button>
          <span className="test-out">
            {missingGuidance.length === 0
              ? 'every skill is already in the prompt'
              : `${missingGuidance.length} ${missingGuidance.length === 1 ? 'skill' : 'skills'} not yet in the prompt`}
          </span>
        </div>
      </div>

      <Field label="Name">
        <input
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="e.g. Researcher"
          autoFocus
        />
        {nameError && <span className="field-error">{nameError}</span>}
      </Field>

      <div className="field-grid">
        <Field label="Avatar emoji">
          <div className="emoji-picker">
            {EMOJI_PALETTE.map((e) => (
              <button
                key={e}
                className={`emoji-opt${draft.emoji === e ? ' is-on' : ''}`}
                onClick={() => patch({ emoji: e })}
                aria-label={`Use ${e}`}
              >
                {e}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <div className="field-grid">
        <Field label="Accent colour">
          <div className="accent-picker">
            {ACCENT_PALETTE.map((c) => (
              <button
                key={c}
                className={`accent-opt${draft.accent === c ? ' is-on' : ''}`}
                style={{ background: c }}
                onClick={() => patch({ accent: c })}
                aria-label={`Accent ${c}`}
              />
            ))}
          </div>
        </Field>
        <Field label="Status">
          <div className="seg">
            {STATUSES.map((s) => (
              <button
                key={s}
                className={draft.status === s ? 'is-on' : ''}
                onClick={() => patch({ status: s })}
              >
                {s}
              </button>
            ))}
          </div>
        </Field>
      </div>

      <Field label="Endpoint URL" hint="where your server listens">
        <input
          value={draft.endpointUrl}
          onChange={(e) => patch({ endpointUrl: e.target.value })}
          placeholder="http://localhost:8001/chat"
          spellCheck={false}
        />
        {endpointError && <span className="field-error">{endpointError}</span>}
      </Field>

      <div className="test-row">
        <button className="btn ghost sm" onClick={runTest} disabled={testing}>
          <RefreshIcon size={14} /> {testing ? 'Testing…' : 'Test connection'}
        </button>
        {testResult && (
          <span className={`test-out${testResult.ok ? ' ok' : ' bad'}`}>
            {testResult.ok ? '✓' : '✕'} {testResult.message}
            {testResult.latencyMs > 0 ? ` · ${testResult.latencyMs}ms` : ''}
          </span>
        )}
      </div>

      <Field
        label="Model"
        hint={
          getSettings().provider === 'pollinations'
            ? 'own-endpoint mode only · Pollinations uses the model in Workspace & API'
            : 'whatever your server expects'
        }
      >
        <input
          value={draft.model}
          onChange={(e) => patch({ model: e.target.value })}
          placeholder="gpt-4o-mini · qwen2.5-coder:32b · llama3.1:70b"
          spellCheck={false}
        />
        {modelError && <span className="field-error">{modelError}</span>}
      </Field>

      <Field label="System prompt" hint={`${draft.systemPrompt.length} chars`}>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => patch({ systemPrompt: e.target.value })}
          rows={5}
          placeholder="You are a helpful agent that…"
        />
      </Field>

      {/* --- advanced budgets (create-skills workstream): mem20crewz max_iter / max_execution_time. --- */}
      <div className="field">
        <span className="field-label">
          Advanced
          <em>optional — blank means the workspace default</em>
        </span>
        <div className="field-grid">
          <Field label="Max iterations" hint="per task · default 10">
            <input
              value={maxIterText}
              onChange={(e) => {
                setMaxIterText(e.target.value);
                patch({ maxIterations: parseBudget(e.target.value) });
              }}
              placeholder="10"
              inputMode="numeric"
              spellCheck={false}
            />
          </Field>
          <Field label="Max execution time (seconds)" hint="blank means unlimited">
            <input
              value={maxExecText}
              onChange={(e) => {
                setMaxExecText(e.target.value);
                patch({ maxExecutionTimeSeconds: parseBudget(e.target.value) });
              }}
              placeholder="unlimited"
              inputMode="numeric"
              spellCheck={false}
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
