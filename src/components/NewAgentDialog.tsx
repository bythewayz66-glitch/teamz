import { useEffect, useMemo, useState } from 'react';
import type { Agent, Conversation, Seniority } from '../types';
import { Modal, Field } from './Modal';
import { AgentAvatar } from './Avatar';
import { CheckIcon, ChevronIcon, PlusIcon, SparkIcon } from './Icons';
import { TemplatePicker } from './TemplatePicker';
import { SkillPicker } from './SkillPicker';
import { ACCENT_PALETTE, EMOJI_PALETTE } from '../data/mock';
import {
  SENIORITY_BLURB,
  SENIORITY_LABELS,
  agentSkillsForKeys,
  expandSkillKeys,
  getCatalogueSummary,
  originFor,
  type AgentTemplate,
} from '../data/templates';
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_ENDPOINT_URL,
  DEFAULT_MAX_ITERATIONS,
  composeSystemPrompt,
} from '../lib/agentPrompt';

interface NewAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Every path — template or from scratch — creates through here, so the
   * wizard's edited prompt, picked skills and budgets survive. The template
   * id is carried on the agent's `origin` instead.
   */
  onCreate: (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => void;
  /**
   * Kept for API compatibility with the previous dialog. Creation no longer
   * goes through the template-only path: it cannot carry an edited prompt,
   * extra skills or budgets, which is exactly what this wizard exists for.
   */
  onCreateFromTemplate: (templateId: string, name?: string, seniority?: Seniority) => void;
  /** Room the new agent will be invited into. */
  room: Conversation | null;
}

const STEPS = ['Role', 'Identity', 'Skills', 'Review'] as const;

type Step = 0 | 1 | 2 | 3;

/** One capability / value per line in the textareas. */
function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function parseBudget(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function NewAgentDialog({ open, onClose, onCreate, room }: NewAgentDialogProps) {
  const [step, setStep] = useState<Step>(0);
  const [visited, setVisited] = useState<Set<number>>(new Set([0]));

  /* ------------------------------ step 1: role ----------------------------- */
  const [mode, setMode] = useState<'template' | 'custom'>('template');
  const [selected, setSelected] = useState<AgentTemplate | null>(null);
  const [customRole, setCustomRole] = useState('');

  /* --------------------------- step 2: identity ---------------------------- */
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [goal, setGoal] = useState('');
  const [backstory, setBackstory] = useState('');
  const [capabilitiesText, setCapabilitiesText] = useState('');
  const [valuesText, setValuesText] = useState('');
  const [emoji, setEmoji] = useState(EMOJI_PALETTE[4]);
  const [accent, setAccent] = useState(ACCENT_PALETTE[0]);
  const [model, setModel] = useState(DEFAULT_AGENT_MODEL);

  /* ---------------------------- step 3: skills ----------------------------- */
  const [skillKeys, setSkillKeys] = useState<string[]>([]);

  /* ----------------------- step 4: review + advanced ------------------------ */
  const [endpointUrl, setEndpointUrl] = useState(DEFAULT_ENDPOINT_URL);
  const [maxIterations, setMaxIterations] = useState('');
  const [maxExecutionTime, setMaxExecutionTime] = useState('');
  /** The prompt as shown in review. Null means "the composed prompt". */
  const [promptOverride, setPromptOverride] = useState<string | null>(null);

  const [summary] = useState(getCatalogueSummary);

  const capabilities = useMemo(() => parseLines(capabilitiesText), [capabilitiesText]);
  const values = useMemo(() => parseLines(valuesText), [valuesText]);
  const skills = useMemo(() => expandSkillKeys(skillKeys), [skillKeys]);

  const brief = mode === 'template' ? selected?.systemPrompt ?? '' : '';

  const composed = useMemo(
    () =>
      composeSystemPrompt({
        name,
        role,
        goal,
        backstory,
        capabilities,
        values,
        brief,
        skills,
        seniority: mode === 'template' ? selected?.seniority : undefined,
        maxIterations: parseBudget(maxIterations),
        maxExecutionTimeSeconds: parseBudget(maxExecutionTime),
      }),
    [
      name,
      role,
      goal,
      backstory,
      capabilities,
      values,
      brief,
      skills,
      mode,
      selected?.seniority,
      maxIterations,
      maxExecutionTime,
    ],
  );

  /** What step 4 shows and creation sends: the edit, or the composed prompt. */
  const prompt = promptOverride ?? composed;
  /** The prompt is stale when the fields changed after the user edited it. */
  const promptStale = promptOverride !== null && promptOverride !== composed;

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setVisited(new Set([0]));
    setMode('template');
    setSelected(null);
    setCustomRole('');
    setName('');
    setRole('');
    setGoal('');
    setBackstory('');
    setCapabilitiesText('');
    setValuesText('');
    setEmoji(EMOJI_PALETTE[Math.floor(Math.random() * EMOJI_PALETTE.length)]);
    setAccent(ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)]);
    setModel(DEFAULT_AGENT_MODEL);
    setSkillKeys([]);
    setEndpointUrl(DEFAULT_ENDPOINT_URL);
    setMaxIterations('');
    setMaxExecutionTime('');
    setPromptOverride(null);
  }, [open]);

  /** Fill the identity + skills from a picked template. */
  const applyTemplate = (template: AgentTemplate | null) => {
    setSelected(template);
    if (!template) return;
    setName(template.name);
    setRole(template.name);
    setGoal(template.description);
    setBackstory('');
    setCapabilitiesText('');
    setValuesText('');
    setEmoji(template.emoji);
    setAccent(template.accent || ACCENT_PALETTE[0]);
    setModel(template.model);
    setSkillKeys(template.skills.map((s) => `${s.category}.${s.id}`));
    setPromptOverride(null);
  };

  const startCustom = () => {
    setMode('custom');
    setSelected(null);
    setRole(customRole);
    setName('');
    setGoal('');
    setBackstory('');
    setCapabilitiesText('');
    setValuesText('');
    setModel(DEFAULT_AGENT_MODEL);
    setSkillKeys([]);
    setPromptOverride(null);
  };

  const goTo = (next: Step) => {
    setStep(next);
    setVisited((v) => new Set(v).add(next));
  };

  const roleReady =
    mode === 'template' ? selected !== null : customRole.trim() !== '' && role.trim() !== '';
  const identityReady = name.trim() !== '';
  const promptReady = prompt.trim() !== '';

  const canNext = step === 0 ? roleReady : step === 1 ? identityReady : step === 2 ? true : promptReady;

  const create = () => {
    if (!promptReady) return;
    onCreate({
      name: name.trim() || 'New Agent',
      emoji,
      accent,
      endpointUrl: endpointUrl.trim() || DEFAULT_ENDPOINT_URL,
      model: model.trim() || DEFAULT_AGENT_MODEL,
      systemPrompt: prompt,
      skills: agentSkillsForKeys(skillKeys),
      origin:
        mode === 'template' && selected
          ? originFor(selected, selected.seniority)
          : undefined,
      role: role.trim(),
      goal: goal.trim(),
      backstory: backstory.trim(),
      capabilities,
      values,
      maxIterations: parseBudget(maxIterations),
      maxExecutionTimeSeconds: parseBudget(maxExecutionTime),
    });
    onClose();
  };

  const roomLabel = room
    ? room.kind === 'channel'
      ? `#${room.name}`
      : room.name
    : 'your workspace';

  const stepSubtitle = [
    `${summary.templates} templates across ${summary.categories} categories. Pick a role and it joins ${roomLabel} — or start from scratch.`,
    'Who is this agent? The role, goal and backstory below compose its system prompt.',
    'Pick the skills this agent draws on. Bundles add a whole group in one click.',
    'Read the composed prompt, edit it if you like, then create the agent.',
  ][step];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add an agent"
      subtitle={stepSubtitle}
      width={820}
      footer={
        <>
          <div className="foot-left">
            {step === 3 && selected && (
              <span className="picker-count">
                <CheckIcon size={12} /> joins {roomLabel}
              </span>
            )}
          </div>
          <div className="foot-right">
            <button className="btn ghost sm" onClick={onClose}>
              Cancel
            </button>
            {step > 0 && (
              <button className="btn ghost sm" onClick={() => goTo((step - 1) as Step)}>
                Back
              </button>
            )}
            {step < 3 ? (
              <button className="btn primary sm" onClick={() => goTo((step + 1) as Step)} disabled={!canNext}>
                Next
              </button>
            ) : (
              <button className="btn primary sm" onClick={create} disabled={!promptReady}>
                <PlusIcon size={14} /> Create agent
              </button>
            )}
          </div>
        </>
      }
    >
      <div className="tabs" role="tablist" aria-label="Creation steps">
        {STEPS.map((label, i) => (
          <button
            key={label}
            className={`tab${step === i ? ' is-on' : ''}`}
            onClick={() => visited.has(i) && goTo(i as Step)}
            role="tab"
            aria-selected={step === i}
            disabled={!visited.has(i)}
          >
            {i + 1}. {label}
          </button>
        ))}
      </div>

      {step === 0 && (
        <>
          <div className="field">
            <span className="field-label">
              Start from
              <em>pick a role, or describe your own</em>
            </span>
            <div className="seg">
              <button
                className={mode === 'template' ? 'is-on' : ''}
                onClick={() => setMode('template')}
              >
                <SparkIcon size={13} /> A template
              </button>
              <button className={mode === 'custom' ? 'is-on' : ''} onClick={startCustom}>
                <PlusIcon size={13} /> From scratch
              </button>
            </div>
          </div>

          {mode === 'template' ? (
            <>
              <TemplatePicker
                selectedId={selected?.id ?? null}
                onSelect={applyTemplate}
                onCreate={() => goTo(1)}
                createLabel="Use this role →"
              />
              {selected && (
                <div className="tpl-level-row">
                  <span className="tpl-level-row-label">
                    Level
                    <em>{SENIORITY_BLURB[selected.seniority]}</em>
                  </span>
                  <div className="tpl-level-row-opts">
                    <span className="tpl-level-pill is-on">
                      {SENIORITY_LABELS[selected.seniority]}
                    </span>
                  </div>
                  <span className="tpl-level-row-hint">
                    Set by the template you picked — use the Level filter above to compare
                    roles across levels.
                  </span>
                </div>
              )}
            </>
          ) : (
            <Field
              label="Role"
              hint="what this agent is — e.g. Code Reviewer, Researcher, Support Lead"
            >
              <input
                value={customRole}
                onChange={(e) => {
                  const v = e.target.value;
                  setCustomRole(v);
                  setRole(v);
                  // Suggest the role as the name until the user types their own.
                  if (!name.trim()) setName(v);
                }}
                placeholder="e.g. Code Reviewer"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && roleReady && goTo(1)}
              />
            </Field>
          )}
        </>
      )}

      {step === 1 && (
        <>
          <div className="settings-preview">
            <AgentAvatar agent={{ name, emoji, accent }} size={52} />
            <div>
              <strong>{name.trim() || 'New Agent'}</strong>
              <span>
                {role.trim() || 'no role yet'} · {model || 'no model set'}
              </span>
            </div>
          </div>

          <div className="field-grid">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Reviewer"
                autoFocus
              />
            </Field>
            <Field label="Role" hint="appears in the prompt as “You are {name}, a {role}”">
              <input
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Code Reviewer"
                spellCheck={false}
              />
            </Field>
          </div>

          <Field label="Goal" hint="one sentence — what this agent is for">
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              rows={2}
              placeholder="e.g. Review every pull request for correctness, tests and blast radius, and say which comments block."
            />
          </Field>

          <Field label="Backstory" hint="optional — where this agent comes from, how it works">
            <textarea
              value={backstory}
              onChange={(e) => setBackstory(e.target.value)}
              rows={2}
              placeholder="e.g. You spent years reviewing other people's code, and it shows: you read the diff before the description."
            />
          </Field>

          <div className="field-grid">
            <Field label="Capabilities" hint="one per line — what it can do">
              <textarea
                value={capabilitiesText}
                onChange={(e) => setCapabilitiesText(e.target.value)}
                rows={3}
                placeholder={'review pull requests\nwrite tests that fail for the right reason'}
              />
            </Field>
            <Field label="Values" hint="one per line — how it works">
              <textarea
                value={valuesText}
                onChange={(e) => setValuesText(e.target.value)}
                rows={3}
                placeholder={'cite the source, never the summary\nno workarounds'}
              />
            </Field>
          </div>

          <Field label="Avatar">
            <div className="emoji-picker">
              {EMOJI_PALETTE.slice(0, 12).map((e) => (
                <button
                  key={e}
                  className={`emoji-opt${emoji === e ? ' is-on' : ''}`}
                  onClick={() => setEmoji(e)}
                  aria-label={`Use ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Accent colour">
            <div className="accent-picker">
              {ACCENT_PALETTE.map((c) => (
                <button
                  key={c}
                  className={`accent-opt${accent === c ? ' is-on' : ''}`}
                  style={{ background: c }}
                  onClick={() => setAccent(c)}
                  aria-label={`Accent ${c}`}
                />
              ))}
            </div>
          </Field>

          <Field
            label="Model"
            hint="used by own-endpoint mode · Pollinations uses the model in Workspace & API"
          >
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={DEFAULT_AGENT_MODEL}
              spellCheck={false}
            />
          </Field>
        </>
      )}

      {step === 2 && (
        <SkillPicker
          selectedKeys={skillKeys}
          onChange={setSkillKeys}
          focusCategory={mode === 'template' ? selected?.category : undefined}
        />
      )}

      {step === 3 && (
        <>
          <div className="settings-preview">
            <AgentAvatar agent={{ name, emoji, accent }} size={52} />
            <div>
              <strong>{name.trim() || 'New Agent'}</strong>
              <span>
                {role.trim() || 'no role yet'} · {model || 'no model set'} ·{' '}
                {skills.length} {skills.length === 1 ? 'skill' : 'skills'}
                {selected ? ` · from ${selected.id}` : ' · from scratch'}
              </span>
            </div>
          </div>

          <Field
            label="System prompt"
            hint={`${prompt.length} chars · composed from role, goal, backstory, capabilities and skills — edit freely`}
          >
            <textarea
              value={prompt}
              onChange={(e) => setPromptOverride(e.target.value)}
              rows={10}
              spellCheck={false}
            />
          </Field>
          {promptStale && (
            <div className="field">
              <span className="field-error">
                You edited this prompt, and the fields changed since. Your edit is kept.
              </span>
              <div>
                <button className="btn ghost sm" onClick={() => setPromptOverride(null)}>
                  <ChevronIcon size={13} /> Re-compose from the fields
                </button>
              </div>
            </div>
          )}
          {!promptReady && (
            <span className="field-error">The system prompt cannot be empty.</span>
          )}

          <div className="field">
            <span className="field-label">
              Advanced
              <em>optional — leave blank for the workspace defaults</em>
            </span>
            <div className="field-grid">
              <Field label="Endpoint URL" hint="own-endpoint mode only">
                <input
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder={DEFAULT_ENDPOINT_URL}
                  spellCheck={false}
                />
              </Field>
              <Field label="Max iterations" hint={`per task · default ${DEFAULT_MAX_ITERATIONS}`}>
                <input
                  value={maxIterations}
                  onChange={(e) => setMaxIterations(e.target.value)}
                  placeholder={String(DEFAULT_MAX_ITERATIONS)}
                  inputMode="numeric"
                  spellCheck={false}
                />
              </Field>
            </div>
            <Field label="Max execution time (seconds)" hint="blank means unlimited">
              <input
                value={maxExecutionTime}
                onChange={(e) => setMaxExecutionTime(e.target.value)}
                placeholder="unlimited"
                inputMode="numeric"
                spellCheck={false}
              />
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}
