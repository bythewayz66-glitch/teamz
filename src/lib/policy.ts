/**
 * ============================================================================
 *  Policy engine — software rules, not prompt rules.
 * ============================================================================
 *
 *  An agent never gets to decide whether it may do something. It proposes an
 *  `AgentAction`; this module decides. The decision is deterministic, testable
 *  and independent of anything the model said, which is the whole point: a
 *  prompt injection cannot widen a policy.
 *
 *  Evaluation order (first match wins):
 *
 *    1. exact service + exact action      `gmail` + `send`
 *    2. exact service + wildcard action   `gmail` + `*`
 *    3. wildcard service + exact action   `*`     + `send`
 *    4. wildcard service + wildcard       `*`     + `*`
 *    5. no rule matched                   → the agent default
 *
 *  Within a tier, a `block` beats a `review` beats an `allow`, so adding a
 *  narrow deny rule can never be silently overridden by a broader allow.
 *
 *  Action names are dotted (`orders.list`, `products.delete`). A rule may also
 *  use a prefix wildcard (`orders.*`) which matches any action under that
 *  namespace — that is how "read orders but not delete them" is expressed.
 */

import type {
  AgentAction,
  PolicyDecision,
  PolicyRule,
  PolicyVerdict,
} from '../types';

/** The decision used when no rule matches at all. */
export const DEFAULT_DECISION: PolicyDecision = 'review';

/** Severity ordering used to break ties inside one specificity tier. */
const SEVERITY: Record<PolicyDecision, number> = { allow: 0, review: 1, block: 2 };

/**
 * Does `pattern` match `action`?
 *
 *   `*`            → everything
 *   `orders.*`     → `orders.list`, `orders.get`, `orders.delete`
 *   `*.list`       → `orders.list`, `products.list` (any namespace)
 *   `orders.list`  → exactly `orders.list`
 */
export function actionMatches(pattern: string, action: string): boolean {
  const p = pattern.trim();
  const a = action.trim();
  if (p === '*' || p === '') return true;
  if (p === a) return true;
  if (p.endsWith('.*')) {
    const prefix = p.slice(0, -1); // keep the dot: "orders."
    return a.startsWith(prefix);
  }
  // Leading wildcard: `*.list` matches any action whose final segment is `list`.
  // Without this, the default policy's `*.list` / `*.get` rules matched nothing
  // and every read fell through to "needs review".
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // keep the dot: ".list"
    return a.endsWith(suffix);
  }
  return false;
}

/** Does `pattern` match `service`? `*` matches every connector. */
export function serviceMatches(pattern: string, service: string): boolean {
  const p = pattern.trim();
  return p === '*' || p === '' || p === service;
}

/**
 * Specificity of a rule, 0 (broadest) .. 3 (narrowest).
 * Used to pick the most specific tier before severity is considered.
 */
export function specificity(rule: Pick<PolicyRule, 'service' | 'action'>): number {
  const svc = rule.service.trim();
  const act = rule.action.trim();
  const svcExact = svc !== '*' && svc !== '';
  const actExact = act !== '*' && act !== '' && !act.endsWith('.*');
  const actPrefix = act.endsWith('.*');
  if (svcExact && actExact) return 3;
  if (svcExact && actPrefix) return 2;
  if (svcExact) return 1;
  if (actExact || actPrefix) return 1;
  return 0;
}

/**
 * Evaluate one action against a rule set.
 *
 * `rules` is the agent's own policy. An empty rule set is not "allow
 * everything" — it falls back to `DEFAULT_DECISION` (`review`), because a
 * brand-new agent should not be able to send email unsupervised.
 */
export function evaluate(
  action: Pick<AgentAction, 'service' | 'action'>,
  rules: PolicyRule[],
  fallback: PolicyDecision = DEFAULT_DECISION,
): PolicyVerdict {
  const matching = rules.filter(
    (r) => serviceMatches(r.service, action.service) && actionMatches(r.action, action.action),
  );

  if (matching.length === 0) {
    return {
      decision: fallback,
      ruleId: null,
      reason:
        fallback === 'allow'
          ? `No rule covers ${action.service}.${action.action}; the agent default allows it.`
          : fallback === 'block'
            ? `No rule covers ${action.service}.${action.action}; the agent default blocks it.`
            : `No rule covers ${action.service}.${action.action}, so it needs a human decision.`,
    };
  }

  // Most specific tier wins; inside a tier the strictest decision wins.
  const best = matching.reduce((acc, rule) => {
    const s = specificity(rule);
    const a = specificity(acc);
    if (s > a) return rule;
    if (s < a) return acc;
    return SEVERITY[rule.decision] > SEVERITY[acc.decision] ? rule : acc;
  });

  const reason =
    best.note?.trim() ||
    (best.decision === 'allow'
      ? `Rule ${best.service}.${best.action} allows this.`
      : best.decision === 'block'
        ? `Rule ${best.service}.${best.action} blocks this.`
        : `Rule ${best.service}.${best.action} requires review.`);

  return { decision: best.decision, ruleId: best.id, reason };
}

/**
 * The default policy a new agent starts with.
 *
 * Reads are allowed, writes need review, destructive actions are blocked.
 * That is the same shape the product shows in its policy editor, and it is
 * deliberately conservative: the user widens it, the agent cannot.
 */
export function defaultPolicy(): PolicyRule[] {
  return [
    { id: 'pol-read', service: '*', action: '*.list', decision: 'allow', note: 'Listing is read-only.' },
    { id: 'pol-get', service: '*', action: '*.get', decision: 'allow', note: 'Fetching one record is read-only.' },
    { id: 'pol-read2', service: '*', action: '*.read', decision: 'allow', note: 'Reading is read-only.' },
    { id: 'pol-write', service: '*', action: '*.send', decision: 'review', note: 'Outbound messages need a human.' },
    { id: 'pol-write2', service: '*', action: '*.create', decision: 'review', note: 'Creating records needs a human.' },
    { id: 'pol-write3', service: '*', action: '*.update', decision: 'review', note: 'Updating records needs a human.' },
    { id: 'pol-destroy', service: '*', action: '*.delete', decision: 'block', note: 'Deletion is blocked outright.' },
    { id: 'pol-fs', service: 'fs', action: 'read', decision: 'block', note: 'The agent cannot read your filesystem.' },
  ];
}

/** Human label for a decision, used in badges. */
export const DECISION_LABEL: Record<PolicyDecision, string> = {
  allow: 'Allowed',
  review: 'Needs review',
  block: 'Blocked',
};

/** Tone class for a decision badge. */
export const DECISION_TONE: Record<PolicyDecision, 'good' | 'warn' | 'bad'> = {
  allow: 'good',
  review: 'warn',
  block: 'bad',
};

/**
 * Group an agent's rules by service for the policy editor, keeping the
 * wildcard bucket last so the specific connectors read first.
 */
export function groupRules(rules: PolicyRule[]): { service: string; rules: PolicyRule[] }[] {
  const map = new Map<string, PolicyRule[]>();
  for (const r of rules) {
    const list = map.get(r.service) ?? [];
    list.push(r);
    map.set(r.service, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '*' ? 1 : b === '*' ? -1 : a.localeCompare(b)))
    .map(([service, list]) => ({ service, rules: list }));
}
