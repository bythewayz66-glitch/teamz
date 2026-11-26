import { describe, expect, it } from 'vitest';
import type { Agent } from '../types';
import { Flow, MAX_AGENT_REPLIES, MAX_CHAIN_DEPTH, runMentionChain } from './mentionFlow';

function agent(id: string, name: string): Agent {
  return {
    id,
    name,
    emoji: '🤖',
    accent: '#7c9cff',
    status: 'online',
    endpointUrl: 'http://localhost:8001/chat',
    model: 'gpt-4o',
    systemPrompt: '',
    skills: [],
    createdAt: 0,
  };
}

const scout = agent('a1', 'Scout');
const atlas = agent('a2', 'Atlas');
const pixel = agent('a3', 'Pixel');
const sage = agent('a4', 'Sage');
const members = [scout, atlas, pixel, sage];

/**
 * A fake `send` that answers from a script: agent id → reply text (or null
 * for "no reply delivered"). This is the test seam for the chain — the flow
 * logic is real, only the network behind the reply is replaced.
 */
function scripted(script: Record<string, string | null>) {
  const calls: { agent: Agent; directed: boolean; mentionedBy?: Agent }[] = [];
  const send = async (a: Agent, directed: boolean, mentionedBy?: Agent) => {
    calls.push({ agent: a, directed, mentionedBy });
    // `in` (not `??`): an explicit null entry means "no reply delivered".
    return a.id in script ? script[a.id] : `Ack from ${a.name}.`;
  };
  return { send, calls };
}

describe('Flow — the mem20crewz shape', () => {
  it('dispatches a start handler, then the states its return names', async () => {
    const flow = new Flow('t');
    const seen: string[] = [];
    flow.start(() => 'one');
    flow.listen('one')(async () => {
      seen.push('one');
      return 'two';
    });
    flow.listen('two')(async () => {
      seen.push('two');
    });
    const run = await flow.run();
    expect(seen).toEqual(['one', 'two']);
    expect(run.emitted).toEqual(['one', 'two']);
  });

  it('a router returns a single routing decision, not every listener hit', async () => {
    const flow = new Flow('t');
    flow.start(() => 'pick');
    flow.router('pick')(async () => ['a', 'b']);
    const ran: string[] = [];
    flow.listen('a')(async () => {
      ran.push('a');
    });
    flow.listen('b')(async () => {
      ran.push('b');
    });
    await flow.run();
    expect(ran).toEqual(['a']);
  });

  it('never runs the same state twice in one run', async () => {
    const flow = new Flow('t');
    let count = 0;
    flow.start(() => ['loop', 'loop']);
    flow.listen('loop')(async () => {
      count += 1;
      return 'loop';
    });
    await flow.run();
    expect(count).toBe(1);
  });

  it('stops at maxStates', async () => {
    const flow = new Flow('t');
    flow.start(() => 's0');
    for (let i = 0; i < 10; i++) {
      flow.listen(`s${i}`)(async () => `s${i + 1}`);
    }
    const run = await flow.run({}, 3);
    expect(run.runs.length).toBe(3);
  });
});

describe('runMentionChain — user @-mentions one agent', () => {
  it('only the mentioned agent replies', async () => {
    const { send, calls } = scripted({ a1: 'On it.' });
    const { replies, stoppedAtCap } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1']);
    expect(calls[0].directed).toBe(true);
    expect(replies.map((r) => r.agent.id)).toEqual(['a1']);
    expect(replies[0].depth).toBe(0);
    expect(stoppedAtCap).toBe(false);
  });

  it('an agent reply @-mentioning another agent chains to them', async () => {
    const { send, calls } = scripted({
      a1: '@Atlas, your call on the architecture?',
      a2: 'Agreed — single module boundary.',
    });
    const { replies } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1', 'a2']);
    expect(replies.map((r) => [r.agent.id, r.depth])).toEqual([
      ['a1', 0],
      ['a2', 1],
    ]);
    // Chained agents are mentioned agents too: directed, and the router
    // tells the send who mentioned them.
    expect(calls[1].directed).toBe(true);
    expect(calls[1].mentionedBy?.id).toBe('a1');
  });

  it('a reply naming two agents brings both in, in mention order', async () => {
    const { send, calls } = scripted({
      a1: '@Atlas and @Pixel, weigh in.',
      a2: 'Architecture is fine.',
      a3: 'Spacing needs work.',
    });
    const { replies } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1', 'a2', 'a3']);
    expect(replies.map((r) => r.agent.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('chains agent to agent across several hops', async () => {
    const { send } = scripted({
      a1: '@Atlas over to you.',
      a2: '@Pixel your turn.',
      a3: 'Done, no handoff.',
    });
    const { replies } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(replies.map((r) => [r.agent.id, r.depth])).toEqual([
      ['a1', 0],
      ['a2', 1],
      ['a3', 2],
    ]);
  });
});

describe('runMentionChain — safety: no infinite loops, ever', () => {
  it('a reply that mentions an agent who already answered does not re-ask them', async () => {
    const { send, calls } = scripted({
      a1: '@Atlas, take it.',
      a2: '@Scout, back to you — loop?',
    });
    const { replies, stoppedAtCap } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1', 'a2']);
    expect(replies.map((r) => r.agent.id)).toEqual(['a1', 'a2']);
    // A blocked re-visit is not a cap hit: the chain ended, it did not stop.
    expect(stoppedAtCap).toBe(false);
  });

  it('an agent @-mentioning itself is ignored', async () => {
    const { send, calls } = scripted({ a1: '@Scout, note to self.' });
    const { replies } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1']);
    expect(replies).toHaveLength(1);
  });

  it('stops at the chain-depth cap and reports it', async () => {
    const chain = [scout, atlas, pixel, sage];
    const script: Record<string, string> = {};
    for (let i = 0; i < chain.length - 1; i++) {
      script[chain[i].id] = `@${chain[i + 1].name} over to you.`;
    }
    script[sage.id] = '@Scout again?';
    const { send } = scripted(script);
    const { replies, stoppedAtCap } = await runMentionChain(
      { members, initialTargets: [scout], initialDirected: true, send },
      { maxChainDepth: 2, maxAgentReplies: 99 },
    );
    // Depth 0, 1, 2 answer; the depth-2 reply's handoff is refused.
    expect(replies.map((r) => [r.agent.id, r.depth])).toEqual([
      ['a1', 0],
      ['a2', 1],
      ['a3', 2],
    ]);
    expect(stoppedAtCap).toBe(true);
  });

  it('stops at the total-replies cap and reports it', async () => {
    const { send } = scripted({
      a1: '@Atlas @Pixel @Sage, all of you.',
      a2: 'Here.',
      a3: '@Scout loop back.',
      a4: 'Here too.',
    });
    const { replies, stoppedAtCap } = await runMentionChain(
      { members, initialTargets: [scout], initialDirected: true, send },
      { maxChainDepth: 99, maxAgentReplies: 3 },
    );
    expect(replies).toHaveLength(3);
    expect(stoppedAtCap).toBe(true);
  });

  it('the default caps are 4 chained turns and 8 total replies', () => {
    expect(MAX_CHAIN_DEPTH).toBe(4);
    expect(MAX_AGENT_REPLIES).toBe(8);
  });

  it('a failed reply (null) routes nowhere', async () => {
    const { send, calls } = scripted({ a1: null });
    const { replies } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1']);
    expect(replies).toHaveLength(0);
  });

  it('a mention of someone outside the channel is ignored', async () => {
    const { send, calls } = scripted({
      a1: '@Outsider, you are not in this room.',
    });
    const { replies } = await runMentionChain({
      members,
      initialTargets: [scout],
      initialDirected: true,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1']);
    expect(replies).toHaveLength(1);
  });
});

describe('runMentionChain — broadcast and 1:1 still work', () => {
  it('broadcast: every member answers once, not directed', async () => {
    const { send, calls } = scripted({
      a1: 'First.',
      a2: 'Second.',
      a3: 'Third.',
      a4: 'Fourth.',
    });
    const { replies, stoppedAtCap } = await runMentionChain({
      members,
      initialTargets: members,
      initialDirected: false,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(calls.every((c) => c.directed === false)).toBe(true);
    expect(replies.map((r) => r.depth)).toEqual([0, 0, 0, 0]);
    expect(stoppedAtCap).toBe(false);
  });

  it('broadcast replies cannot re-trigger members who already answered', async () => {
    const { send, calls } = scripted({
      a1: '@Atlas what do you think?',
      a2: 'Already said my piece.',
      a3: 'Third.',
      a4: 'Fourth.',
    });
    const { replies } = await runMentionChain({
      members,
      initialTargets: members,
      initialDirected: false,
      send,
    });
    // Atlas answered in the broadcast round; Scout's mention of them later
    // in that same round does not produce a second reply.
    expect(calls.map((c) => c.agent.id)).toEqual(['a1', 'a2', 'a3', 'a4']);
    expect(replies).toHaveLength(4);
  });

  it('1:1: the single member answers, mention or not', async () => {
    const { send, calls } = scripted({ a1: 'Just us.' });
    const { replies } = await runMentionChain({
      members: [scout],
      initialTargets: [scout],
      initialDirected: false,
      send,
    });
    expect(calls.map((c) => c.agent.id)).toEqual(['a1']);
    expect(replies).toHaveLength(1);
  });

  it('no initial targets means no replies', async () => {
    const { send, calls } = scripted({});
    const { replies } = await runMentionChain({
      members,
      initialTargets: [],
      initialDirected: false,
      send,
    });
    expect(calls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});
