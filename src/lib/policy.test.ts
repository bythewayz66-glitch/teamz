import { describe, expect, it } from 'vitest';
import {
  actionMatches,
  defaultPolicy,
  evaluate,
  groupRules,
  serviceMatches,
  specificity,
} from './policy';
import type { PolicyRule } from '../types';

const rule = (over: Partial<PolicyRule>): PolicyRule => ({
  id: 'r',
  service: '*',
  action: '*',
  decision: 'allow',
  ...over,
});

describe('actionMatches', () => {
  it('matches everything on *', () => {
    expect(actionMatches('*', 'orders.delete')).toBe(true);
  });

  it('matches an exact action only', () => {
    expect(actionMatches('orders.list', 'orders.list')).toBe(true);
    expect(actionMatches('orders.list', 'orders.delete')).toBe(false);
  });

  it('matches a namespace prefix', () => {
    expect(actionMatches('orders.*', 'orders.list')).toBe(true);
    expect(actionMatches('orders.*', 'orders.delete')).toBe(true);
    expect(actionMatches('orders.*', 'products.list')).toBe(false);
  });

  it('does not treat a bare prefix as a wildcard', () => {
    expect(actionMatches('orders', 'orders.list')).toBe(false);
  });
});

describe('serviceMatches', () => {
  it('matches every service on *', () => {
    expect(serviceMatches('*', 'gmail')).toBe(true);
  });
  it('is exact otherwise', () => {
    expect(serviceMatches('gmail', 'gmail')).toBe(true);
    expect(serviceMatches('gmail', 'slack')).toBe(false);
  });
});

describe('specificity', () => {
  it('ranks service+action above service-only above wildcard', () => {
    expect(specificity({ service: 'gmail', action: 'send' })).toBe(3);
    expect(specificity({ service: 'gmail', action: 'orders.*' })).toBe(2);
    expect(specificity({ service: 'gmail', action: '*' })).toBe(1);
    expect(specificity({ service: '*', action: '*' })).toBe(0);
  });
});

describe('evaluate', () => {
  it('falls back to review when nothing matches', () => {
    const v = evaluate({ service: 'gmail', action: 'send' }, []);
    expect(v.decision).toBe('review');
    expect(v.ruleId).toBeNull();
  });

  it('honours an explicit fallback', () => {
    expect(evaluate({ service: 'x', action: 'y' }, [], 'allow').decision).toBe('allow');
  });

  it('prefers the most specific rule over a broader one', () => {
    const rules = [
      rule({ id: 'broad', service: '*', action: '*', decision: 'allow' }),
      rule({ id: 'narrow', service: 'gmail', action: 'send', decision: 'block' }),
    ];
    const v = evaluate({ service: 'gmail', action: 'send' }, rules);
    expect(v.decision).toBe('block');
    expect(v.ruleId).toBe('narrow');
  });

  it('lets a narrow deny beat a broad allow', () => {
    const rules = [
      rule({ id: 'allow-all', service: 'gmail', action: '*', decision: 'allow' }),
      rule({ id: 'deny-send', service: 'gmail', action: 'send', decision: 'block' }),
    ];
    expect(evaluate({ service: 'gmail', action: 'send' }, rules).decision).toBe('block');
  });

  it('breaks ties inside one tier by severity', () => {
    const rules = [
      rule({ id: 'a', service: 'gmail', action: 'send', decision: 'allow' }),
      rule({ id: 'b', service: 'gmail', action: 'send', decision: 'review' }),
    ];
    expect(evaluate({ service: 'gmail', action: 'send' }, rules).decision).toBe('review');
  });

  it('uses the rule note as the reason when present', () => {
    const rules = [rule({ id: 'n', service: 'gmail', action: 'send', decision: 'block', note: 'No mail.' })];
    expect(evaluate({ service: 'gmail', action: 'send' }, rules).reason).toBe('No mail.');
  });
});

describe('defaultPolicy', () => {
  it('allows reads, reviews writes and blocks deletes', () => {
    const p = defaultPolicy();
    expect(evaluate({ service: 'shopify', action: 'orders.list' }, p).decision).toBe('allow');
    expect(evaluate({ service: 'gmail', action: 'send' }, p).decision).toBe('review');
    expect(evaluate({ service: 'shopify', action: 'products.delete' }, p).decision).toBe('block');
  });

  it('blocks filesystem reads outright', () => {
    expect(evaluate({ service: 'fs', action: 'read' }, defaultPolicy()).decision).toBe('block');
  });
});

describe('groupRules', () => {
  it('puts the wildcard bucket last', () => {
    const groups = groupRules([
      rule({ id: '1', service: '*' }),
      rule({ id: '2', service: 'gmail' }),
    ]);
    expect(groups.map((g) => g.service)).toEqual(['gmail', '*']);
  });
});
