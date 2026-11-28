import { describe, expect, it } from 'vitest';
import { mergeRunnerAgents } from './useWorkspace';
import { seedState } from '../data/mock';
import type { RunnerAgentSummary } from '../api/runnerState';

// The Build Room must hold the whole live fleet, not just the 35 seed
// agents. Jesse found the Orchestrator assigning work there that nobody
// could see, and had to join all 106 agents by hand (Nov 28, 2026).
describe('mergeRunnerAgents — Build Room holds the whole live fleet', () => {
  it('adds runner agents that are missing from the Build Room', () => {
    const prev = structuredClone(seedState);
    const room = prev.conversations.find((c) => c.id === 'conv-build-room');
    expect(room).toBeDefined();
    const before = room!.agentIds.length;
    expect(before).toBeLessThan(106);

    // One agent already in the room (Atlas, a seed agent) and two that are
    // only in the runner state (a product agent + a new one). endpointUrl
    // is given so the merge never reads window.location (node test env).
    const serverAgents: RunnerAgentSummary[] = [
      { id: 'agent-atlas', name: 'Atlas', model: 'deepseek-ai/DeepSeek-V4-Flash-0731', endpointUrl: 'http://127.0.0.1:8897/chat' },
      { id: 'agent-feedback-analyst', name: 'Feedback Analyst', model: 'deepseek-ai/DeepSeek-V4-Flash-0731', endpointUrl: 'http://127.0.0.1:8897/chat' },
      { id: 'agent-data-quality-engineer', name: 'Data Quality Engineer', model: 'deepseek-ai/DeepSeek-V4-Flash-0731', endpointUrl: 'http://127.0.0.1:8897/chat' },
    ];
    const next = mergeRunnerAgents(prev, serverAgents);
    const nextRoom = next.conversations.find((c) => c.id === 'conv-build-room');
    expect(nextRoom).toBeDefined();
    expect(nextRoom!.agentIds).toContain('agent-feedback-analyst');
    expect(nextRoom!.agentIds).toContain('agent-data-quality-engineer');
    expect(nextRoom!.agentIds.length).toBe(before + 2);
    // The new agents are also in the agent list.
    expect(next.agents.map((a) => a.id)).toContain('agent-feedback-analyst');
    expect(next.agents.map((a) => a.id)).toContain('agent-data-quality-engineer');
  });

  it('does not duplicate agents already in the room', () => {
    const prev = structuredClone(seedState);
    const room = prev.conversations.find((c) => c.id === 'conv-build-room')!;
    const serverAgents: RunnerAgentSummary[] = room.agentIds.slice(0, 3).map((id) => ({
      id,
      name: id,
      model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      endpointUrl: 'http://127.0.0.1:8897/chat',
    }));
    const next = mergeRunnerAgents(prev, serverAgents);
    const nextRoom = next.conversations.find((c) => c.id === 'conv-build-room')!;
    expect(nextRoom.agentIds.length).toBe(room.agentIds.length);
    expect(new Set(nextRoom.agentIds).size).toBe(nextRoom.agentIds.length);
  });
});
