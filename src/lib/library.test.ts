import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIBRARY_SEEDS } from '../data/library/seeds.generated';
import type { Agent } from '../types';
import {
  agentInputFromTemplate,
  bumpVersion,
  currentVersion,
  diffVersions,
  firstSessionFor,
  instantiationBlock,
  lineDiff,
  publishFromAgent,
  recordReview,
  templateFromImport,
  templateFromSeed,
  type LibraryTemplate,
} from './library';
import { addCustom, emptyLibrary, findImportBySha, parseLibrary, SEED_TEMPLATES } from './libraryState';
import { parseGamutAgent } from './gamutImport';

const root = new URL('../../', import.meta.url);
const json = (f: string) => JSON.parse(readFileSync(new URL(f, root), 'utf8')) as Array<Record<string, any>>;

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'agent-x',
  name: 'Scribe',
  emoji: '📝',
  accent: '#7c9cff',
  status: 'online',
  endpointUrl: 'http://localhost:8001/chat',
  model: 'openai-fast',
  systemPrompt: 'You are Scribe.\nYou write plainly.\nYou cite sources.',
  skills: [],
  createdAt: 0,
  ...over,
});

let n = 0;
const idFactory = (name: string) => `lib.${name.toLowerCase()}-${++n}`;

describe('seed templates come from the fleet, verbatim', () => {
  it('ships the agents the roadmap names, and nothing invented', () => {
    const names = LIBRARY_SEEDS.map((s) => s.name);
    for (const must of ['Orchestrator', 'Reviewer', 'Website Currency Agent', 'Drift Monitor']) expect(names).toContain(must);
    expect(LIBRARY_SEEDS).toHaveLength(8);
    expect(new Set(LIBRARY_SEEDS.map((s) => s.id)).size).toBe(8);
  });

  it('each prompt and first job equals what the fleet files hold', () => {
    const pools: Record<string, Array<Record<string, any>>> = {
      'runner-agents.json': json('runner-agents.json'),
      'new-agents-40.json': json('new-agents-40.json'),
      'new-agents-1-website-currency.json': json('new-agents-1-website-currency.json'),
    };
    const jobs = json('future-work-104.json');
    for (const s of LIBRARY_SEEDS) {
      const src = pools[s.source.agentFile].find((a) => a.id === s.source.agentId)!;
      expect(s.systemPrompt).toBe(src.systemPrompt);
      expect(s.model).toBe(src.model);
      const job = s.source.firstJobFile === 'future-work-104.json' ? jobs.find((j) => j.agentId === s.source.agentId)! : src.firstJob;
      expect(s.firstJob?.title).toBe(job.title);
      expect(s.firstJob?.prompt).toBe(job.prompt);
    }
  });

  it('the generated file is current (node scripts/build-library-seeds.mjs --check)', () => {
    const out = execFileSync('node', ['scripts/build-library-seeds.mjs', '--check'], { cwd: new URL('.', root), encoding: 'utf8' });
    expect(out).toMatch(/up to date/);
  });

  it('derived fields only claim what the prompt says', () => {
    for (const s of LIBRARY_SEEDS) for (const t of s.runnerTools) expect(s.systemPrompt).toContain(t);
    const drift = SEED_TEMPLATES.find((t) => t.name === 'Drift Monitor')!;
    expect(currentVersion(drift).content.firstJob).toMatchObject({ kind: 'recurring', schedule: '0 * * * *' });
    expect(currentVersion(drift).content.needs.join(' ')).toContain('repo_read');
  });

  it('are version 1.0.0, shipped, and usable', () => {
    for (const t of SEED_TEMPLATES) {
      expect(currentVersion(t).version).toBe('1.0.0');
      expect(t.review.status).toBe('builtin');
      expect(instantiationBlock(t)).toBeNull();
    }
  });
});

describe('versions', () => {
  it('bumps semver', () => {
    expect(bumpVersion(null, 'patch')).toBe('1.0.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(() => bumpVersion('v1', 'patch')).toThrow();
  });

  it('publishing starts at 1.0.0, unreviewed', () => {
    const t = publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'First cut', now: 1, idFactory });
    expect(currentVersion(t).version).toBe('1.0.0');
    expect(t.review.status).toBe('unreviewed');
    expect(t.source).toMatchObject({ kind: 'published', fromAgentId: 'agent-x' });
  });

  it('republishing adds a version, keeps the old one, and puts the template back behind the Reviewer', () => {
    const v1 = publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'First cut', now: 1, idFactory });
    const approved = recordReview(v1, 'approved', 'Reviewer', 'reads well', 2);
    expect(instantiationBlock(approved)).toBeNull();
    const v2 = publishFromAgent({
      existing: approved,
      agent: agent({ systemPrompt: 'You are Scribe.\nYou write plainly.\nYou never guess.', model: 'other-model' }),
      bump: 'minor',
      note: 'Stops guessing',
      now: 3,
      idFactory,
    });
    expect(v2.versions.map((v) => v.version)).toEqual(['1.0.0', '1.1.0']);
    expect(v2.review.status).toBe('unreviewed');
    expect(instantiationBlock(v2)).not.toBeNull();
  });

  it('refuses a version with no change, no note, or over a fleet template', () => {
    const t = publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'n', now: 1, idFactory });
    expect(() => publishFromAgent({ existing: t, agent: agent(), bump: 'patch', note: 'again', now: 2, idFactory })).toThrow(/Nothing changed/);
    expect(() => publishFromAgent({ existing: null, agent: agent(), bump: 'patch', note: '  ', now: 2, idFactory })).toThrow(/note/);
    expect(() => publishFromAgent({ existing: SEED_TEMPLATES[0], agent: agent(), bump: 'patch', note: 'x', now: 2, idFactory })).toThrow(/published from this workspace/);
  });
});

describe('what changed between two versions', () => {
  const mk = () => {
    const v1 = publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'a', now: 1, idFactory });
    return publishFromAgent({
      existing: v1,
      agent: agent({
        systemPrompt: 'You are Scribe.\nYou write plainly.\nYou never guess.',
        model: 'bigger-model',
        skills: [{ key: 'creative.editing', label: 'Editing', level: 3 }],
      }),
      bump: 'minor',
      note: 'b',
      now: 2,
      idFactory,
    });
  };

  it('reports prompt lines, model and skills', () => {
    const t = mk();
    const d = diffVersions(t.versions[0], t.versions[1]);
    expect(d.from).toBe('1.0.0');
    expect(d.to).toBe('1.1.0');
    const byField = Object.fromEntries(d.changes.map((c) => [c.field, c]));
    expect(byField.systemPrompt.lines).toEqual({ added: ['You never guess.'], removed: ['You cite sources.'], unchanged: 2 });
    expect(byField.model).toMatchObject({ before: 'openai-fast', after: 'bigger-model' });
    expect(byField.skillKeys.after).toContain('+ creative.editing');
  });

  it('reports nothing for identical versions', () => {
    const t = mk();
    expect(diffVersions(t.versions[1], t.versions[1]).changes).toEqual([]);
  });

  it('lineDiff handles empty and total replacement', () => {
    expect(lineDiff('', 'a')).toMatchObject({ added: ['a'], removed: [''] });
    expect(lineDiff('a\nb', 'c\nd')).toMatchObject({ added: ['c', 'd'], removed: ['a', 'b'], unchanged: 0 });
  });
});

describe('the Reviewer gate', () => {
  it('records a decision only with a recorder and a reason, and never on built-ins', () => {
    const t = publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'n', now: 1, idFactory });
    expect(() => recordReview(t, 'approved', ' ', 'ok', 2)).toThrow(/who/);
    expect(() => recordReview(t, 'approved', 'R', '', 2)).toThrow(/reason/);
    expect(() => recordReview(SEED_TEMPLATES[0], 'rejected', 'R', 'no', 2)).toThrow(/Built-in/);
    expect(recordReview(t, 'rejected', 'R', 'unsafe', 2).review).toMatchObject({ status: 'rejected', by: 'R' });
  });

  it('a rejected template stays blocked', () => {
    const t = recordReview(publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'n', now: 1, idFactory }), 'rejected', 'R', 'no', 2);
    expect(instantiationBlock(t)).toMatch(/rejected/);
    expect(() => agentInputFromTemplate(t)).toThrow(/rejected/);
  });
});

describe('a Gamut import lands as an unreviewed template and never reaches the fleet unreviewed', () => {
  const fixture = new Uint8Array(readFileSync(new URL('gamut-reference/company-brain.agent', root)));

  it('stays blocked until approved, then instantiates with the exported instructions as the prompt', async () => {
    const imp = await parseGamutAgent(fixture);
    const t = templateFromImport(imp, { id: 'gamut-1', filename: 'company-brain.agent', now: 5 });
    expect(t.review.status).toBe('unreviewed');
    expect(t.source).toMatchObject({ kind: 'gamut-import', filename: 'company-brain.agent' });
    expect(t.imported?.rawInstructions).toBe(imp.rawInstructions);
    expect(instantiationBlock(t)).toMatch(/Imported from Gamut and not reviewed/);
    expect(() => agentInputFromTemplate(t)).toThrow(/not reviewed/);

    const approved = recordReview(t, 'approved', 'Reviewer', 'instructions read, no keys', 6);
    const input = agentInputFromTemplate(approved);
    expect(input.systemPrompt).toBe(imp.body);
    expect(input.origin).toMatchObject({ templateId: 'library:gamut-1@1.0.0', familySlug: 'library' });
    expect(currentVersion(t).content.needs.join('\n')).toContain('KNOWLEDGE_SOURCE_API_KEY (name only, no value imported)');
  });

  it('is recognised when imported twice', async () => {
    const imp = await parseGamutAgent(fixture);
    const s = addCustom(emptyLibrary(), templateFromImport(imp, { id: 'g', filename: 'a.agent', now: 1 }));
    expect(findImportBySha(s, imp.archiveSha256)?.id).toBe('g');
  });
});

describe('first session', () => {
  it('carries the template’s job and holds no invented messages', () => {
    const t = SEED_TEMPLATES.find((x) => x.name === 'Drift Monitor')!;
    const c = firstSessionFor(t, currentVersion(t), 'agent-new', 'sess-1', 9);
    expect(c.kind).toBe('session');
    expect(c.agentIds).toEqual(['agent-new']);
    expect(c.session?.intro?.job?.title).toMatch(/Hourly drift check/);
    expect(c.session?.intro?.template).toBe('teamz.drift-monitor@1.0.0');
    expect(c.name.startsWith('First job — ')).toBe(true);
  });

  it('says plainly when there is no first job', () => {
    const t = publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'n', now: 1, idFactory });
    const c = firstSessionFor(t, currentVersion(t), 'a', 's', 1);
    expect(c.session?.intro?.job).toBeNull();
    expect(c.name).toBe('First session');
  });

  it('every seed has a first job to introduce', () => {
    for (const t of SEED_TEMPLATES) expect(firstSessionFor(t, currentVersion(t), 'a', 's', 1).session?.intro?.job).not.toBeNull();
  });
});

describe('persisted library', () => {
  it('drops malformed entries and never accepts a custom template claiming to be built in', () => {
    const good = publishFromAgent({ existing: null, agent: agent(), bump: 'minor', note: 'n', now: 1, idFactory });
    const forged: LibraryTemplate = { ...good, id: 'forged', review: { status: 'builtin' } };
    const parsed = parseLibrary(JSON.stringify({ custom: [good, forged, { id: 1 }, null] }));
    expect(parsed.custom.map((t) => t.id)).toEqual([good.id]);
    expect(parseLibrary('not json').custom).toEqual([]);
    expect(parseLibrary(null).custom).toEqual([]);
  });

  it('templateFromSeed is deterministic', () => {
    expect(templateFromSeed(LIBRARY_SEEDS[0])).toEqual(templateFromSeed(LIBRARY_SEEDS[0]));
  });
});

describe('summaries', () => {
  it('are whole leading sentences of the prompt, never fragments', () => {
    for (const t of SEED_TEMPLATES) {
      const c = currentVersion(t).content;
      const flat = c.systemPrompt.replace(/\s+/g, ' ').trim();
      expect(flat.startsWith(c.summary.replace(/…$/, '')), t.name).toBe(true);
    }
  });
});
