/** Sections: the fleet grouped by programme, with a visible "Unassigned" bucket. */

import type { Agent } from '../types';
import { AGENT_PROGRAMME, PROGRAMMES } from '../data/programmes';

export const UNASSIGNED_ID = 'unassigned';

export interface Section {
  id: string;
  label: string;
  blurb: string;
  agents: Agent[];
}

export function programmeOf(agentId: string): string {
  return AGENT_PROGRAMME[agentId] ?? UNASSIGNED_ID;
}

/** Sections in declared order; empty programmes are dropped; the rest of the fleet is shown, not hidden. */
export function buildSections(agents: Agent[]): Section[] {
  const out: Section[] = PROGRAMMES.map((p) => ({ id: p.id, label: p.label, blurb: p.blurb, agents: [] }));
  const rest: Section = { id: UNASSIGNED_ID, label: 'Unassigned', blurb: 'Agents no programme claims yet.', agents: [] };
  const byId = new Map(out.map((s) => [s.id, s]));
  for (const a of agents) (byId.get(programmeOf(a.id)) ?? rest).agents.push(a);
  for (const s of [...out, rest]) s.agents.sort((a, b) => a.name.localeCompare(b.name));
  return [...out, rest].filter((s) => s.agents.length > 0);
}
