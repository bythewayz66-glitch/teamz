/**
 * Team Library: versioned agent templates (Teamz's own proven agents, agents
 * published from this workspace, and Gamut imports) plus the versioned skill
 * bundles. Pure logic, DOM-free; the store lives in `store/useLibrary.ts`.
 *
 * Governance: a template that came from outside the shipped code (published or
 * imported) is `unreviewed` until the Reviewer's decision is recorded, and an
 * unreviewed or rejected template cannot become an agent.
 */

import type { Agent, Conversation, SessionIntro } from '../types';
import { agentSkillsForKeys } from '../data/templates';
import { DEFAULT_AGENT_MODEL, DEFAULT_ENDPOINT_URL } from './agentPrompt';
import { DEFAULT_RETENTION } from './sessions';
import type { GamutImport } from './gamutImport';

/* ------------------------------------------------------------------ types */

export interface FirstJob {
  title: string;
  prompt: string;
  kind: 'one-off' | 'recurring';
  schedule: string | null;
}

/** Everything that is versioned about a template. */
export interface LibraryContent {
  /** What it does, one or two sentences. */
  summary: string;
  /** What it needs to work: runner tools, provider, connections. */
  needs: string[];
  systemPrompt: string;
  model: string;
  provider: string | null;
  emoji: string;
  accent: string;
  maxIterations: number | null;
  /** Tools of the runner that the prompt names (repo_read, …). */
  runnerTools: string[];
  /** Registry keys, e.g. `engineering.code-review`. */
  skillKeys: string[];
  firstJob: FirstJob | null;
  /** Where the first job came from; null when there is none. */
  firstJobSource: string | null;
}

export interface TemplateVersion {
  version: string;
  publishedAt: number;
  note: string;
  content: LibraryContent;
}

export type TemplateSource =
  | { kind: 'teamz-fleet'; agentId: string; agentFile: string; firstJobFile: string | null }
  | { kind: 'published'; fromAgentId: string; fromAgentName: string }
  | {
      kind: 'gamut-import';
      filename: string;
      archiveSha256: string;
      instructionsPath: string;
      importedAt: number;
    };

export interface ReviewState {
  /** `builtin` = shipped in the code through a reviewed PR. */
  status: 'builtin' | 'unreviewed' | 'approved' | 'rejected';
  /** Who recorded the decision. Teamz cannot authenticate them: it records. */
  by?: string;
  at?: number;
  note?: string;
}

export interface ImportedDetail {
  /** The instructions entry exactly as exported, frontmatter included. */
  rawInstructions: string;
  skills: Array<{ name: string; description: string }>;
  files: Array<{ path: string; bytes: number }>;
  envNames: string[];
  createdAt?: string;
  version?: string;
}

export interface LibraryTemplate {
  id: string;
  name: string;
  /** Oldest first; the last one is current. */
  versions: TemplateVersion[];
  source: TemplateSource;
  review: ReviewState;
  imported?: ImportedDetail;
}

/** Shape of `data/library/seeds.generated.ts` entries. */
export interface LibrarySeed {
  id: string;
  name: string;
  emoji: string;
  accent: string;
  model: string;
  provider: string | null;
  maxIterations: number | null;
  systemPrompt: string;
  runnerTools: string[];
  firstJob: FirstJob | null;
  source: { kind: 'teamz-fleet'; agentId: string; agentFile: string; firstJobFile: string | null };
}

export const SEED_VERSION = '1.0.0';
export const SEED_DATE = Date.UTC(2026, 10, 28);

/* ---------------------------------------------------------------- helpers */

export const currentVersion = (t: LibraryTemplate): TemplateVersion => t.versions[t.versions.length - 1];

export function findVersion(t: LibraryTemplate, version: string): TemplateVersion | undefined {
  return t.versions.find((v) => v.version === version);
}

/** FNV-1a, hex. Not a security hash: a change detector for released content. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const firstSentences = (text: string, max = 300): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  let out = '';
  for (const s of flat.split(/(?<=[.!?])\s+/)) {
    if (out && (out + ' ' + s).length > max) break;
    out = out ? `${out} ${s}` : s;
  }
  return out.length > max ? `${out.slice(0, max - 1).trimEnd()}…` : out;
};

function needsFor(c: Pick<LibraryContent, 'runnerTools' | 'provider' | 'model'>): string[] {
  const needs: string[] = [];
  if (c.runnerTools.length > 0) {
    needs.push(`The 24/7 runner, for its tools: ${c.runnerTools.join(', ')}`);
  }
  needs.push(c.provider ? `Model access: ${c.model} via ${c.provider}` : `Model access: ${c.model}`);
  return needs;
}

export function templateFromSeed(seed: LibrarySeed): LibraryTemplate {
  const content: LibraryContent = {
    summary: firstSentences(seed.systemPrompt),
    needs: needsFor(seed),
    systemPrompt: seed.systemPrompt,
    model: seed.model,
    provider: seed.provider,
    emoji: seed.emoji,
    accent: seed.accent,
    maxIterations: seed.maxIterations,
    runnerTools: seed.runnerTools,
    skillKeys: [],
    firstJob: seed.firstJob,
    firstJobSource: seed.firstJob ? seed.source.firstJobFile : null,
  };
  return {
    id: seed.id,
    name: seed.name,
    versions: [{ version: SEED_VERSION, publishedAt: SEED_DATE, note: 'Taken from the fleet as it ran.', content }],
    source: seed.source,
    review: { status: 'builtin', note: 'Shipped with Teamz; the agent runs in the live fleet.' },
  };
}

/* -------------------------------------------------------------- versioning */

export type Bump = 'major' | 'minor' | 'patch';

export function bumpVersion(prev: string | null, bump: Bump): string {
  if (!prev) return '1.0.0';
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(prev);
  if (!m) throw new Error(`Not a version: ${prev}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (bump === 'major') return `${maj + 1}.0.0`;
  if (bump === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

export function contentFromAgent(
  agent: Agent,
  extras: { summary?: string; firstJob?: FirstJob | null } = {},
): LibraryContent {
  const runnerTools = ['repo_read', 'stage_patch', 'fetch_url', 'room_read', 'web_search'].filter((t) =>
    agent.systemPrompt.includes(t),
  );
  const base = {
    runnerTools,
    provider: null as string | null,
    model: agent.model,
  };
  const enabled = agent.enabledTools ?? [];
  return {
    summary: (extras.summary?.trim() || agent.goal?.trim() || firstSentences(agent.systemPrompt)).slice(0, 400),
    needs: [...needsFor(base), ...enabled.map((t) => `Tool: ${t}`)],
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    provider: null,
    emoji: agent.emoji,
    accent: agent.accent,
    maxIterations: agent.maxIterations ?? null,
    runnerTools,
    skillKeys: agent.skills.map((s) => s.key).filter((k) => /^[a-z-]+\.[a-z0-9-]+$/.test(k)),
    firstJob: extras.firstJob ?? null,
    firstJobSource: extras.firstJob ? 'Published with the template' : null,
  };
}

export interface PublishInput {
  existing: LibraryTemplate | null;
  agent: Agent;
  bump: Bump;
  note: string;
  now: number;
  summary?: string;
  firstJob?: FirstJob | null;
  idFactory: (name: string) => string;
}

/** Publishes an agent as a new template, or as the next version of one it published before. */
export function publishFromAgent(input: PublishInput): LibraryTemplate {
  const { existing, agent, bump, note, now } = input;
  if (existing && existing.source.kind !== 'published') {
    throw new Error('Only a template published from this workspace can get a new version here.');
  }
  if (!note.trim()) throw new Error('A version needs a note saying what changed.');
  const content = contentFromAgent(agent, { summary: input.summary, firstJob: input.firstJob });
  const previous = existing ? currentVersion(existing) : null;
  const version: TemplateVersion = {
    version: bumpVersion(previous?.version ?? null, bump),
    publishedAt: now,
    note: note.trim(),
    content,
  };
  if (previous && fingerprint(previous.content) === fingerprint(content)) {
    throw new Error('Nothing changed since the last version; there is nothing to publish.');
  }
  // New content goes back behind the Reviewer, whatever was approved before.
  const review: ReviewState = { status: 'unreviewed' };
  if (existing) return { ...existing, name: agent.name, versions: [...existing.versions, version], review };
  return {
    id: input.idFactory(agent.name),
    name: agent.name,
    versions: [version],
    source: { kind: 'published', fromAgentId: agent.id, fromAgentName: agent.name },
    review,
  };
}

export function templateFromImport(
  imp: GamutImport,
  meta: { id: string; filename: string; now: number },
): LibraryTemplate {
  const content: LibraryContent = {
    summary: imp.frontmatter.description,
    needs: [
      `Model access: ${DEFAULT_AGENT_MODEL}`,
      ...imp.skills.map((s) => `Gamut skill: ${s.name}`),
      ...imp.envNames.map((n) => `Environment variable: ${n} (name only, no value imported)`),
    ],
    systemPrompt: imp.body,
    model: DEFAULT_AGENT_MODEL,
    provider: null,
    emoji: '📦',
    accent: '#a78bfa',
    maxIterations: null,
    runnerTools: [],
    skillKeys: [],
    firstJob: null,
    firstJobSource: null,
  };
  return {
    id: meta.id,
    name: imp.frontmatter.name,
    versions: [
      {
        version: imp.frontmatter.version && /^\d+\.\d+\.\d+$/.test(imp.frontmatter.version) ? imp.frontmatter.version : '1.0.0',
        publishedAt: meta.now,
        note: `Imported from ${meta.filename}.`,
        content,
      },
    ],
    source: {
      kind: 'gamut-import',
      filename: meta.filename,
      archiveSha256: imp.archiveSha256,
      instructionsPath: imp.instructionsPath,
      importedAt: meta.now,
    },
    review: { status: 'unreviewed' },
    imported: {
      rawInstructions: imp.rawInstructions,
      skills: imp.skills.map((s) => ({ name: s.name, description: s.description })),
      files: imp.files,
      envNames: imp.envNames,
      createdAt: imp.frontmatter.createdAt,
      version: imp.frontmatter.version,
    },
  };
}

export function recordReview(
  t: LibraryTemplate,
  decision: 'approved' | 'rejected',
  by: string,
  note: string,
  now: number,
): LibraryTemplate {
  if (t.review.status === 'builtin') throw new Error('Built-in templates are reviewed through the code.');
  if (!by.trim()) throw new Error('Say who is recording the Reviewer’s decision.');
  if (!note.trim()) throw new Error('A decision needs a reason.');
  return { ...t, review: { status: decision, by: by.trim(), at: now, note: note.trim() } };
}

/* -------------------------------------------------------------------- diff */

export interface LineDiff {
  added: string[];
  removed: string[];
  unchanged: number;
}

/** LCS line diff; falls back to set difference for very large inputs. */
export function lineDiff(before: string, after: string): LineDiff {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) {
    const sa = new Set(a);
    const sb = new Set(b);
    return {
      added: b.filter((l) => !sa.has(l)),
      removed: a.filter((l) => !sb.has(l)),
      unchanged: a.filter((l) => sb.has(l)).length,
    };
  }
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  let i = 0;
  let j = 0;
  let same = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      same++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  while (i < a.length) removed.push(a[i++]);
  while (j < b.length) added.push(b[j++]);
  return { added, removed, unchanged: same };
}

export interface FieldChange {
  field: string;
  label: string;
  kind: 'changed' | 'added' | 'removed';
  before?: string;
  after?: string;
  /** For the system prompt: the line-level change. */
  lines?: LineDiff;
}

export interface TemplateDiff {
  from: string;
  to: string;
  changes: FieldChange[];
}

const show = (v: unknown): string => (v === null || v === undefined || v === '' ? '(none)' : String(v));

function listChange(field: string, label: string, before: string[], after: string[]): FieldChange | null {
  const b = new Set(before);
  const a = new Set(after);
  const added = after.filter((x) => !b.has(x));
  const removed = before.filter((x) => !a.has(x));
  if (added.length === 0 && removed.length === 0) return null;
  return {
    field,
    label,
    kind: 'changed',
    before: before.join('\n') || '(none)',
    after: [...added.map((x) => `+ ${x}`), ...removed.map((x) => `− ${x}`)].join('\n'),
  };
}

export function diffVersions(a: TemplateVersion, b: TemplateVersion): TemplateDiff {
  const x = a.content;
  const y = b.content;
  const changes: FieldChange[] = [];
  const scalar = (field: string, label: string, before: unknown, after: unknown) => {
    if (show(before) !== show(after)) {
      changes.push({
        field,
        label,
        kind: before == null || before === '' ? 'added' : after == null || after === '' ? 'removed' : 'changed',
        before: show(before),
        after: show(after),
      });
    }
  };
  scalar('summary', 'What it does', x.summary, y.summary);
  if (x.systemPrompt !== y.systemPrompt) {
    changes.push({ field: 'systemPrompt', label: 'System prompt', kind: 'changed', lines: lineDiff(x.systemPrompt, y.systemPrompt) });
  }
  scalar('model', 'Model', x.model, y.model);
  scalar('provider', 'Provider', x.provider, y.provider);
  scalar('maxIterations', 'Iteration budget', x.maxIterations, y.maxIterations);
  scalar('emoji', 'Avatar', x.emoji, y.emoji);
  scalar('accent', 'Colour', x.accent, y.accent);
  for (const c of [
    listChange('needs', 'What it needs', x.needs, y.needs),
    listChange('runnerTools', 'Runner tools', x.runnerTools, y.runnerTools),
    listChange('skillKeys', 'Skills', x.skillKeys, y.skillKeys),
  ]) {
    if (c) changes.push(c);
  }
  scalar('firstJob.title', 'First job: title', x.firstJob?.title, y.firstJob?.title);
  scalar('firstJob.prompt', 'First job: prompt', x.firstJob?.prompt, y.firstJob?.prompt);
  scalar('firstJob.schedule', 'First job: schedule', x.firstJob?.schedule, y.firstJob?.schedule);
  return { from: a.version, to: b.version, changes };
}

/* ---------------------------------------------------------- instantiation */

/** Why this template cannot become an agent right now, or null. */
export function instantiationBlock(t: LibraryTemplate): string | null {
  switch (t.review.status) {
    case 'builtin':
    case 'approved':
      return null;
    case 'rejected':
      return 'The Reviewer rejected this template.';
    case 'unreviewed':
      return t.source.kind === 'gamut-import'
        ? 'Imported from Gamut and not reviewed yet: it stays a template until the Reviewer decides.'
        : 'Not reviewed yet: it stays a template until the Reviewer decides.';
  }
}

export function agentInputFromTemplate(
  t: LibraryTemplate,
  opts: { name?: string; version?: string } = {},
): Omit<Agent, 'id' | 'createdAt' | 'status'> {
  const block = instantiationBlock(t);
  if (block) throw new Error(block);
  const v = opts.version ? findVersion(t, opts.version) : currentVersion(t);
  if (!v) throw new Error(`${t.name} has no version ${opts.version}.`);
  const c = v.content;
  return {
    name: opts.name?.trim() || t.name,
    emoji: c.emoji,
    accent: c.accent,
    endpointUrl: DEFAULT_ENDPOINT_URL,
    model: c.model,
    systemPrompt: c.systemPrompt,
    skills: agentSkillsForKeys(c.skillKeys),
    origin: { templateId: `library:${t.id}@${v.version}`, familySlug: 'library', role: t.name },
    maxIterations: c.maxIterations ?? undefined,
  };
}

export function introFor(t: LibraryTemplate, version: TemplateVersion): SessionIntro {
  const j = version.content.firstJob;
  return {
    template: `${t.id}@${version.version}`,
    job: j ? { title: j.title, prompt: j.prompt, kind: j.kind, schedule: j.schedule } : null,
    jobSource: j ? version.content.firstJobSource : null,
  };
}

/** The first session of a freshly made agent: it carries the job, and holds no invented messages. */
export function firstSessionFor(
  t: LibraryTemplate,
  version: TemplateVersion,
  agentId: string,
  id: string,
  now: number,
): Conversation {
  const intro = introFor(t, version);
  const title = intro.job ? `First job — ${intro.job.title}` : 'First session';
  return {
    id,
    kind: 'session',
    name: title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title,
    agentIds: [agentId],
    createdAt: now,
    session: {
      kind: 'chat',
      agentId,
      status: 'active',
      retention: DEFAULT_RETENTION.chat,
      updatedAt: now,
      intro,
    },
  };
}
