import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_VALUES,
  composeSystemPrompt,
  formatSkillGuidance,
  skillsMissingFromPrompt,
} from './agentPrompt';

describe('composeSystemPrompt', () => {
  it('composes role, goal, backstory, capabilities and values in order', () => {
    const prompt = composeSystemPrompt({
      name: 'Scout',
      role: 'Researcher',
      goal: 'Find primary sources and cite them.',
      backstory: 'You spent years in an archive, and it shows.',
      capabilities: ['search the web', 'summarise tightly'],
      values: ['cite the source, never the summary'],
    });

    expect(prompt).toContain('You are Scout, a Researcher.');
    expect(prompt).toContain('Your goal: Find primary sources and cite them.');
    expect(prompt).toContain('You spent years in an archive, and it shows.');
    expect(prompt).toContain('- search the web');
    expect(prompt).toContain('- summarise tightly');
    expect(prompt).toContain('- cite the source, never the summary');
    // Sections appear in identity order.
    const order = ['You are Scout', 'Your goal:', 'archive', 'You are able to:', 'principles:'];
    const positions = order.map((s) => prompt.indexOf(s));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('never returns an empty prompt, even with no fields at all', () => {
    const prompt = composeSystemPrompt({ name: '', role: '' });
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('You are New Agent, a helpful assistant.');
    expect(prompt).toContain('Your goal:');
    for (const capability of DEFAULT_CAPABILITIES) {
      expect(prompt).toContain(`- ${capability}`);
    }
    for (const value of DEFAULT_VALUES) {
      expect(prompt).toContain(`- ${value}`);
    }
  });

  it('falls back to a role-derived goal when no goal is given', () => {
    const prompt = composeSystemPrompt({ name: 'Atlas', role: 'Backend Engineer' });
    expect(prompt).toContain('Your goal: Help with Backend Engineer work');
  });

  it('keeps a template brief verbatim and layers the composed sections after it', () => {
    const brief = 'You are a senior frontend engineer. You name every loading state.';
    const prompt = composeSystemPrompt({
      name: 'Pixel',
      role: 'Senior Frontend Engineer',
      brief,
      goal: 'Build React front-ends with explicit state.',
    });
    expect(prompt).toContain(brief);
    expect(prompt.indexOf(brief)).toBeLessThan(prompt.indexOf('Your goal:'));
    expect(prompt.indexOf(brief)).toBeGreaterThan(prompt.indexOf('You are Pixel'));
  });

  it('appends skill guidance with real descriptions, never bare labels', () => {
    const prompt = composeSystemPrompt({
      name: 'Reviewer',
      role: 'Code Reviewer',
      skills: [
        { name: 'Code review', description: 'Reviews for correctness and blast radius.' },
        { name: 'Testing', description: 'Writes tests that fail for the right reason.' },
      ],
    });
    expect(prompt).toContain('Skills you draw on:');
    expect(prompt).toContain('- Code review: Reviews for correctness and blast radius.');
    expect(prompt).toContain('- Testing: Writes tests that fail for the right reason.');
  });

  it('omits the skills block entirely when there are no skills', () => {
    const prompt = composeSystemPrompt({ name: 'Solo', role: 'Helper' });
    expect(prompt).not.toContain('Skills you draw on:');
  });

  it('prepends the seniority clause when a level is given', () => {
    const prompt = composeSystemPrompt({
      name: 'Lead Dev',
      role: 'Lead Engineer',
      seniority: 'lead',
    });
    expect(prompt).toContain('You lead others.');
  });

  it('adds the budget limits only when they are set', () => {
    const withBudgets = composeSystemPrompt({
      name: 'Worker',
      role: 'Runner',
      maxIterations: 5,
      maxExecutionTimeSeconds: 120,
    });
    expect(withBudgets).toContain('at most 5 tool iterations per task');
    expect(withBudgets).toContain('stop after 120 seconds');

    const withoutBudgets = composeSystemPrompt({ name: 'Worker', role: 'Runner' });
    expect(withoutBudgets).not.toContain('Work within these limits:');
  });

  it('ignores zero/negative budgets instead of writing nonsense limits', () => {
    const prompt = composeSystemPrompt({
      name: 'Worker',
      role: 'Runner',
      maxIterations: 0,
      maxExecutionTimeSeconds: -1,
    });
    expect(prompt).not.toContain('Work within these limits:');
  });

  it('trims whitespace and drops blank capability/value lines', () => {
    const prompt = composeSystemPrompt({
      name: '  Neat  ',
      role: '  Editor ',
      capabilities: ['  cut filler  ', '   ', ''],
      values: [''],
    });
    expect(prompt).toContain('You are Neat, an Editor.');
    expect(prompt).toContain('- cut filler');
    expect(prompt).not.toContain('-  \n');
  });
});

describe('formatSkillGuidance', () => {
  it('returns an empty string with no skills', () => {
    expect(formatSkillGuidance([])).toBe('');
  });

  it('renders a skill without a description as a bare name line', () => {
    expect(formatSkillGuidance([{ name: 'React' }])).toBe(
      'Skills you draw on:\n- React',
    );
  });
});

describe('skillsMissingFromPrompt', () => {
  it('reports only the skills not already named in the prompt', () => {
    const prompt = 'You are a reviewer.\n\nSkills you draw on:\n- Code review: be thorough.';
    const missing = skillsMissingFromPrompt(prompt, [
      { name: 'Code review' },
      { name: 'Testing' },
    ]);
    expect(missing.map((s) => s.name)).toEqual(['Testing']);
  });

  it('matches case-insensitively', () => {
    const missing = skillsMissingFromPrompt('uses REACT daily', [{ name: 'React' }]);
    expect(missing).toEqual([]);
  });
});
