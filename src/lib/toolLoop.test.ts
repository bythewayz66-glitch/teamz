import { describe, expect, it } from 'vitest';
import { buildToolSystemPrompt, parseAction, runToolLoop, TOOL_ACTION_CONTRACT } from './toolLoop';
import type { Agent } from '../types';

describe('parseAction', () => {
  it('parses a bare tool action', () => {
    expect(parseAction('{"action": "tool", "tool": "wikipedia", "args": "Ada Lovelace"}')).toEqual({
      action: 'tool',
      tool: 'wikipedia',
      args: 'Ada Lovelace',
    });
  });

  it('parses a bare final action', () => {
    expect(parseAction('{"action": "final", "final": "Here is the answer."}')).toEqual({
      action: 'final',
      final: 'Here is the answer.',
    });
  });

  it('extracts JSON embedded in prose', () => {
    const raw = 'Let me check that.\n{"action": "tool", "tool": "calculator", "args": "2+2"}\nDone.';
    expect(parseAction(raw)).toEqual({ action: 'tool', tool: 'calculator', args: '2+2' });
  });

  it('falls back to the raw text when the JSON is malformed', () => {
    const raw = '{"action": "tool", "tool": "wikipedia", "args": }';
    expect(parseAction(raw)).toEqual({ action: 'final', final: raw });
  });

  it('falls back to the raw text for plain prose', () => {
    expect(parseAction('Just a normal answer, no JSON here.')).toEqual({
      action: 'final',
      final: 'Just a normal answer, no JSON here.',
    });
  });

  it('falls back when the JSON is not an object', () => {
    expect(parseAction('[1, 2, 3]')).toEqual({ action: 'final', final: '[1, 2, 3]' });
  });

  it('falls back when a tool action names no tool', () => {
    const raw = '{"action": "tool", "args": "x"}';
    expect(parseAction(raw)).toEqual({ action: 'final', final: raw });
  });

  it('falls back for an unknown action', () => {
    const raw = '{"action": "dance", "final": "nope"}';
    expect(parseAction(raw)).toEqual({ action: 'final', final: raw });
  });

  it('treats a missing args field as an empty string', () => {
    expect(parseAction('{"action": "tool", "tool": "weather"}')).toEqual({
      action: 'tool',
      tool: 'weather',
      args: '',
    });
  });
});

describe('runToolLoop', () => {
  it('proposes, executes, observes, then returns the final text', async () => {
    const seen: string[][] = [];
    const propose = async (observations: string[]) => {
      seen.push([...observations]);
      if (observations.length === 0) {
        return '{"action": "tool", "tool": "calculator", "args": "2 + 3 * 4"}';
      }
      return '{"action": "final", "final": "The answer is 14."}';
    };
    const steps: string[] = [];
    const result = await runToolLoop(propose, {
      onStep: (s) => steps.push(`${s.action}:${s.tool ?? ''}`),
    });
    expect(result.text).toBe('The answer is 14.');
    expect(result.text).not.toContain('{');
    expect(result.iterations).toBe(2);
    expect(steps).toEqual(['tool:calculator', 'final:']);
    // The tool result was fed back as an observation before the final turn.
    expect(seen[1][0]).toContain('[tool calculator] 2 + 3 * 4 = 14');
    expect(result.observations).toHaveLength(1);
  });

  it('returns plain prose as the final answer without a tool call', async () => {
    const result = await runToolLoop(async () => 'Just a normal answer.');
    expect(result.text).toBe('Just a normal answer.');
    expect(result.iterations).toBe(1);
    expect(result.steps[0].action).toBe('final');
  });

  it('stops at the iteration bound instead of looping forever', async () => {
    const result = await runToolLoop(
      async () => '{"action": "tool", "tool": "calculator", "args": "1 + 1"}',
      { maxIterations: 3 },
    );
    expect(result.iterations).toBe(3);
    expect(result.steps.every((s) => s.action === 'tool')).toBe(true);
    expect(result.text).toContain('[reached the tool limit]');
    expect(result.text).toContain('1 + 1 = 2');
  });

  it('rejects a premature final until a tool has succeeded (guard)', async () => {
    const calls: string[] = [];
    const propose = async (observations: string[]) => {
      calls.push(observations.join(' | '));
      if (observations.length === 0) return '{"action": "final", "final": "Done already!"}';
      if (observations.length === 1) return '{"action": "tool", "tool": "calculator", "args": "40 + 2"}';
      return '{"action": "final", "final": "The answer is 42."}';
    };
    const actions: string[] = [];
    const result = await runToolLoop(propose, {
      requireToolBeforeFinal: true,
      onStep: (s) => actions.push(s.action),
    });
    expect(result.text).toBe('The answer is 42.');
    expect(actions).toEqual(['final-rejected', 'tool', 'final']);
    // The guard message was fed back as an observation after the rejection.
    expect(calls[1]).toContain("[guard] 'final' rejected");
  });

  it('accepts the final on the last iteration even with the guard on', async () => {
    const result = await runToolLoop(async () => '{"action": "final", "final": "Best I can do."}', {
      requireToolBeforeFinal: true,
      maxIterations: 2,
    });
    expect(result.text).toBe('Best I can do.');
    expect(result.iterations).toBe(2);
  });

  it('feeds a tool error back as an observation so the model can recover', async () => {
    const propose = async (observations: string[]) => {
      if (observations.length === 0) return '{"action": "tool", "tool": "calculator", "args": "1 / 0"}';
      return `{"action": "final", "final": "The calculator refused: ${observations[0]}"}`;
    };
    const result = await runToolLoop(propose);
    expect(result.text).toContain('division by zero');
    expect(result.steps[0].ok).toBe(false);
    expect(result.iterations).toBe(2);
  });

  it('feeds an unknown tool back as an observation instead of crashing', async () => {
    const propose = async (observations: string[]) => {
      if (observations.length === 0) return '{"action": "tool", "tool": "teleporter", "args": "Mars"}';
      return '{"action": "final", "final": "No teleporter here."}';
    };
    const result = await runToolLoop(propose);
    expect(result.text).toBe('No teleporter here.');
    expect(result.observations[0]).toContain('unknown tool: teleporter');
  });

  it('surfaces a first-turn propose failure instead of inventing an answer', async () => {
    await expect(runToolLoop(async () => { throw new Error('LLM down'); })).rejects.toThrow('LLM down');
  });
});

describe('buildToolSystemPrompt', () => {
  const agent = (over: Partial<Agent> = {}): Agent => ({
    id: 'a',
    name: 'Scout',
    emoji: '🔍',
    accent: '#fff',
    status: 'online',
    endpointUrl: '',
    model: 'm',
    systemPrompt: 'You research things.',
    skills: [{ key: 'research', label: 'Research', level: 5 }],
    createdAt: 0,
    ...over,
  });

  it('assembles labeled blocks: identity, skills, tools, contract', () => {
    const prompt = buildToolSystemPrompt(agent(), ['wikipedia', 'calculator']);
    expect(prompt).toContain('## Agent identity');
    expect(prompt).toContain('- name: Scout');
    expect(prompt).toContain('- instructions: You research things.');
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('Research');
    expect(prompt).toContain('## Tools you may call');
    expect(prompt).toContain('wikipedia');
    expect(prompt).toContain('calculator');
    expect(prompt).toContain('## How to use tools');
    expect(prompt).toContain(TOOL_ACTION_CONTRACT.split('\n')[0]);
    expect(prompt).not.toContain('weather');
  });
});
