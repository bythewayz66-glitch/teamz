import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '../types';
import { AGENT_PROGRAMME, PROGRAMMES } from '../data/programmes';
import { buildSections, UNASSIGNED_ID } from './sections';

const fleet: Array<{ id: string; name: string }> = JSON.parse(readFileSync(join(process.cwd(), 'agents-104-list.json'), 'utf-8'));
const mk = (id: string, name: string): Agent => ({ id, name, emoji: 'A', accent: '#fff', status: 'online', endpointUrl: '', model: 'm', systemPrompt: '', skills: [], createdAt: 0 });

describe('programmes', () => {
  it('assigns every one of the 106 fleet agents to exactly one declared programme', () => {
    const ids = new Set(PROGRAMMES.map((p) => p.id));
    for (const f of fleet) expect(ids.has(AGENT_PROGRAMME[f.id]), f.name).toBe(true);
    expect(Object.keys(AGENT_PROGRAMME).sort()).toEqual(fleet.map((f) => f.id).sort());
  });

  it('builds sections covering the whole fleet with no unassigned agents', () => {
    const sections = buildSections(fleet.map((f) => mk(f.id, f.name)));
    expect(sections.reduce((n, s) => n + s.agents.length, 0)).toBe(106);
    expect(sections.find((s) => s.id === UNASSIGNED_ID)).toBeUndefined();
  });

  it('shows an agent no programme claims under Unassigned instead of hiding it', () => {
    const sections = buildSections([mk('agent-new', 'Brand New'), mk('agent-reviewer', 'Reviewer')]);
    expect(sections.find((s) => s.id === UNASSIGNED_ID)!.agents.map((a) => a.id)).toEqual(['agent-new']);
    expect(sections.find((s) => s.id === 'core')!.agents.map((a) => a.id)).toEqual(['agent-reviewer']);
  });
});
