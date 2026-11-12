/**
 * ============================================================================
 *  useOrchestration — the state behind the Automations panel.
 * ============================================================================
 *
 *  Kept separate from `useWorkspace` on purpose. `useWorkspace` owns the chat
 *  domain (agents, conversations, messages) and is already large; this hook
 *  owns the *operational* domain (triggers, connections, policy, approvals,
 *  audit, usage, widgets) and persists it under its own key.
 *
 *  The two are composed in `App.tsx`, and the seam between them is deliberate:
 *  sending a message calls `logAudit` + `recordRun` here, so the audit trail
 *  and the usage ledger reflect real activity rather than seeded fiction.
 *
 *  Every mutation is a pure reducer over the persisted slice, so the whole
 *  thing is testable without a DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Approval,
  AuditEntry,
  Connection,
  Notification,
  PolicyDecision,
  PolicyRule,
  Session,
  SkillDef,
  Trigger,
  TriggerRun,
  UsageEntry,
  Widget,
} from '../types';
import {
  seedApprovals,
  seedAudit,
  seedConnections,
  seedMembers,
  seedNotifications,
  seedPolicies,
  seedSessions,
  seedSkills,
  seedTriggerRuns,
  seedTriggers,
  seedUsage,
  seedWidgets,
} from '../data/seed';
import { defaultPolicy, evaluate } from '../lib/policy';
import { isDue, parseCron } from '../lib/cron';
import { policyForConnector } from '../lib/connectors';
import { estimateTokens, recordUsage } from '../lib/context';

const STORAGE_KEY = 'teamz:orchestration:v1';

const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export interface OrchestrationState {
  sessions: Session[];
  connections: Connection[];
  policies: Record<string, PolicyRule[]>;
  triggers: Trigger[];
  triggerRuns: TriggerRun[];
  approvals: Approval[];
  audit: AuditEntry[];
  widgets: Widget[];
  notifications: Notification[];
  usage: UsageEntry[];
  skills: Record<string, SkillDef[]>;
}

function seed(): OrchestrationState {
  return {
    sessions: structuredClone(seedSessions),
    connections: structuredClone(seedConnections),
    policies: structuredClone(seedPolicies),
    triggers: structuredClone(seedTriggers),
    triggerRuns: structuredClone(seedTriggerRuns),
    approvals: structuredClone(seedApprovals),
    audit: structuredClone(seedAudit),
    widgets: structuredClone(seedWidgets),
    notifications: structuredClone(seedNotifications),
    usage: structuredClone(seedUsage),
    skills: structuredClone(seedSkills),
  };
}

/**
 * Normalise a blob written by an older build. Every collection is optional on
 * read so an upgrade never throws, and a missing policy falls back to the
 * conservative default rather than to "allow everything".
 */
function migrate(raw: Partial<OrchestrationState>): OrchestrationState {
  const base = seed();
  return {
    sessions: raw.sessions ?? base.sessions,
    connections: raw.connections ?? base.connections,
    policies: raw.policies ?? base.policies,
    triggers: raw.triggers ?? base.triggers,
    triggerRuns: raw.triggerRuns ?? base.triggerRuns,
    approvals: raw.approvals ?? base.approvals,
    audit: raw.audit ?? base.audit,
    widgets: raw.widgets ?? base.widgets,
    notifications: raw.notifications ?? base.notifications,
    usage: raw.usage ?? base.usage,
    skills: raw.skills ?? base.skills,
  };
}

function load(): OrchestrationState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seed();
    return migrate(JSON.parse(raw) as Partial<OrchestrationState>);
  } catch {
    return seed();
  }
}

/** Cap the audit trail so the persisted blob cannot grow without bound. */
const AUDIT_LIMIT = 400;

export interface UseOrchestration {
  state: OrchestrationState;
  members: typeof seedMembers;
  /** Pending approvals, newest first. */
  pendingApprovals: Approval[];
  unreadCount: number;
  /** Sessions for one agent, newest first, pinned first. */
  sessionsFor: (agentId: string) => Session[];
  skillsFor: (agentId: string) => SkillDef[];
  policyFor: (agentId: string) => PolicyRule[];
  triggersFor: (agentId: string) => Trigger[];
  widgetsFor: (agentId: string) => Widget[];

  /** Append an audit line. Called by the chat layer on every real send. */
  logAudit: (entry: Omit<AuditEntry, 'id' | 'at'>) => void;
  /** Fold a completed run into the usage ledger. */
  recordRun: (agentId: string, promptText: string, replyText: string) => void;

  createSession: (agentId: string, title: string) => Session;
  renameSession: (id: string, title: string) => void;
  togglePinSession: (id: string) => void;
  deleteSession: (id: string) => void;

  connect: (service: string) => void;
  disconnect: (id: string) => void;

  setDecision: (agentId: string, ruleId: string, decision: PolicyDecision) => void;
  addRule: (agentId: string, rule: Omit<PolicyRule, 'id'>) => void;
  removeRule: (agentId: string, ruleId: string) => void;
  resetPolicy: (agentId: string) => void;

  addTrigger: (t: Omit<Trigger, 'id' | 'createdAt' | 'fireCount'>) => Trigger;
  toggleTrigger: (id: string) => void;
  deleteTrigger: (id: string) => void;
  /** Fire a trigger immediately, recording a run and an audit line. */
  runTrigger: (id: string) => void;
  /** Fire every enabled cron trigger whose scheduled minute has passed. */
  tickTriggers: () => number;

  decideApproval: (id: string, approve: boolean) => void;
  markNotificationsRead: () => void;
  addWidget: (w: Omit<Widget, 'id' | 'updatedAt'>) => void;
  removeWidget: (id: string) => void;
  resetOrchestration: () => void;
}

export function useOrchestration(): UseOrchestration {
  const [state, setState] = useState<OrchestrationState>(load);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Persist, debounced, exactly like the workspace slice.
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* quota — the in-memory state still works for this session */
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [state]);

  const logAudit = useCallback((entry: Omit<AuditEntry, 'id' | 'at'>) => {
    setState((s) => ({
      ...s,
      audit: [{ ...entry, id: uid('aud'), at: Date.now() }, ...s.audit].slice(0, AUDIT_LIMIT),
    }));
  }, []);

  const recordRun = useCallback((agentId: string, promptText: string, replyText: string) => {
    setState((s) => ({
      ...s,
      usage: recordUsage(
        s.usage,
        agentId,
        estimateTokens(promptText),
        estimateTokens(replyText),
      ),
    }));
  }, []);

  /* ------------------------------------------------------------- sessions */

  const createSession = useCallback((agentId: string, title: string) => {
    const session: Session = {
      id: uid('sess'),
      agentId,
      title: title.trim() || 'New session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    setState((s) => ({ ...s, sessions: [session, ...s.sessions] }));
    return session;
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    setState((s) => ({
      ...s,
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title, updatedAt: Date.now() } : x)),
    }));
  }, []);

  const togglePinSession = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x)),
    }));
  }, []);

  const deleteSession = useCallback((id: string) => {
    setState((s) => ({ ...s, sessions: s.sessions.filter((x) => x.id !== id) }));
  }, []);

  /* ---------------------------------------------------------- connections */

  const connect = useCallback((service: string) => {
    setState((s) => {
      const existing = s.connections.find((c) => c.service === service);
      const connection: Connection = {
        id: existing?.id ?? uid('conn'),
        service,
        account: 'you@teamz.local',
        scopes: [],
        connectedAt: Date.now(),
        lastUsedAt: Date.now(),
        status: 'connected',
      };
      // Connecting a service also installs its default policy, so a new
      // connection is never silently unrestricted.
      const policies = { ...s.policies };
      for (const agentId of Object.keys(policies)) {
        const already = policies[agentId].some((r) => r.service === service);
        if (already) continue;
        policies[agentId] = [
          ...policies[agentId],
          ...policyForConnector(service).map((r) => ({ ...r, id: uid('pol') })),
        ];
      }
      return {
        ...s,
        connections: existing
          ? s.connections.map((c) => (c.service === service ? connection : c))
          : [...s.connections, connection],
        policies,
        audit: [
          {
            id: uid('aud'),
            at: Date.now(),
            action: `${service}.connect`,
            decision: 'info' as const,
            detail: `Connected ${service} and installed its default policy`,
          },
          ...s.audit,
        ].slice(0, AUDIT_LIMIT),
      };
    });
  }, []);

  const disconnect = useCallback((id: string) => {
    setState((s) => {
      const conn = s.connections.find((c) => c.id === id);
      return {
        ...s,
        connections: s.connections.filter((c) => c.id !== id),
        audit: [
          {
            id: uid('aud'),
            at: Date.now(),
            action: `${conn?.service ?? 'service'}.disconnect`,
            decision: 'info' as const,
            detail: `Disconnected ${conn?.account ?? 'account'}`,
          },
          ...s.audit,
        ].slice(0, AUDIT_LIMIT),
      };
    });
  }, []);

  /* --------------------------------------------------------------- policy */

  const setDecision = useCallback((agentId: string, ruleId: string, decision: PolicyDecision) => {
    setState((s) => ({
      ...s,
      policies: {
        ...s.policies,
        [agentId]: (s.policies[agentId] ?? []).map((r) =>
          r.id === ruleId ? { ...r, decision } : r,
        ),
      },
    }));
  }, []);

  const addRule = useCallback((agentId: string, rule: Omit<PolicyRule, 'id'>) => {
    setState((s) => ({
      ...s,
      policies: {
        ...s.policies,
        [agentId]: [...(s.policies[agentId] ?? []), { ...rule, id: uid('pol') }],
      },
    }));
  }, []);

  const removeRule = useCallback((agentId: string, ruleId: string) => {
    setState((s) => ({
      ...s,
      policies: {
        ...s.policies,
        [agentId]: (s.policies[agentId] ?? []).filter((r) => r.id !== ruleId),
      },
    }));
  }, []);

  const resetPolicy = useCallback((agentId: string) => {
    setState((s) => ({ ...s, policies: { ...s.policies, [agentId]: defaultPolicy() } }));
  }, []);

  /* ------------------------------------------------------------- triggers */

  const addTrigger = useCallback((t: Omit<Trigger, 'id' | 'createdAt' | 'fireCount'>) => {
    const trigger: Trigger = { ...t, id: uid('trig'), createdAt: Date.now(), fireCount: 0 };
    setState((s) => ({ ...s, triggers: [trigger, ...s.triggers] }));
    return trigger;
  }, []);

  const toggleTrigger = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      triggers: s.triggers.map((t) => (t.id === id ? { ...t, enabled: !t.enabled } : t)),
    }));
  }, []);

  const deleteTrigger = useCallback((id: string) => {
    setState((s) => ({
      ...s,
      triggers: s.triggers.filter((t) => t.id !== id),
      triggerRuns: s.triggerRuns.filter((r) => r.triggerId !== id),
    }));
  }, []);

  /**
   * Fire one trigger. Records a run, bumps the counter, and writes an audit
   * line — the same three things a real scheduler would do.
   */
  const fire = useCallback((trigger: Trigger, summary: string, status: 'ok' | 'error' = 'ok') => {
    setState((s) => ({
      ...s,
      triggers: s.triggers.map((t) =>
        t.id === trigger.id
          ? {
              ...t,
              lastFiredAt: Date.now(),
              fireCount: t.fireCount + 1,
              lastError: status === 'error' ? summary : undefined,
            }
          : t,
      ),
      triggerRuns: [
        { id: uid('run'), triggerId: trigger.id, agentId: trigger.agentId, at: Date.now(), status, summary },
        ...s.triggerRuns,
      ].slice(0, 200),
      audit: [
        {
          id: uid('aud'),
          at: Date.now(),
          agentId: trigger.agentId,
          action: 'trigger.fire',
          decision: 'info' as const,
          detail: `${trigger.name} — ${summary}`,
        },
        ...s.audit,
      ].slice(0, AUDIT_LIMIT),
      notifications: [
        {
          id: uid('notif'),
          at: Date.now(),
          kind: status === 'ok' ? ('trigger' as const) : ('error' as const),
          title: `${trigger.name} ran`,
          body: summary,
          read: false,
          agentId: trigger.agentId,
        },
        ...s.notifications,
      ].slice(0, 60),
    }));
  }, []);

  const runTrigger = useCallback(
    (id: string) => {
      const trigger = stateRef.current.triggers.find((t) => t.id === id);
      if (!trigger) return;
      fire(trigger, `Manual run · ${trigger.prompt.slice(0, 60)}`);
    },
    [fire],
  );

  /**
   * The scheduler tick. Called on an interval by the panel; fires every enabled
   * cron trigger whose scheduled minute has passed since its last run.
   * Returns how many fired, so the caller can decide whether to re-render.
   */
  const tickTriggers = useCallback(() => {
    const now = Date.now();
    let fired = 0;
    for (const t of stateRef.current.triggers) {
      if (!t.enabled || t.kind !== 'cron' || !t.cron) continue;
      const spec = parseCron(t.cron);
      if (!spec) continue;
      if (isDue(spec, t.lastFiredAt, now)) {
        fire(t, `Scheduled run · ${t.prompt.slice(0, 60)}`);
        fired++;
      }
    }
    return fired;
  }, [fire]);

  /* ------------------------------------------------------------ approvals */

  const decideApproval = useCallback((id: string, approve: boolean) => {
    setState((s) => {
      const approval = s.approvals.find((a) => a.id === id);
      if (!approval) return s;
      return {
        ...s,
        approvals: s.approvals.map((a) =>
          a.id === id
            ? {
                ...a,
                status: approve ? ('approved' as const) : ('denied' as const),
                decidedAt: Date.now(),
                decidedBy: 'you',
              }
            : a,
        ),
        audit: [
          {
            id: uid('aud'),
            at: Date.now(),
            agentId: approval.agentId,
            sessionId: approval.sessionId,
            action: `${approval.action.service}.${approval.action.action}`,
            decision: approve ? ('allow' as const) : ('block' as const),
            detail: `${approve ? 'Approved' : 'Denied'} — ${approval.action.summary}`,
            ruleId: approval.verdict.ruleId ?? undefined,
            executed: approve,
          },
          ...s.audit,
        ].slice(0, AUDIT_LIMIT),
      };
    });
  }, []);

  const markNotificationsRead = useCallback(() => {
    setState((s) => ({ ...s, notifications: s.notifications.map((n) => ({ ...n, read: true })) }));
  }, []);

  /* -------------------------------------------------------------- widgets */

  const addWidget = useCallback((w: Omit<Widget, 'id' | 'updatedAt'>) => {
    setState((s) => ({
      ...s,
      widgets: [{ ...w, id: uid('wid'), updatedAt: Date.now() }, ...s.widgets],
    }));
  }, []);

  const removeWidget = useCallback((id: string) => {
    setState((s) => ({ ...s, widgets: s.widgets.filter((w) => w.id !== id) }));
  }, []);

  const resetOrchestration = useCallback(() => setState(seed()), []);

  /* -------------------------------------------------------------- derived */

  const pendingApprovals = useMemo(
    () => state.approvals.filter((a) => a.status === 'pending'),
    [state.approvals],
  );

  const unreadCount = useMemo(
    () => state.notifications.filter((n) => !n.read).length,
    [state.notifications],
  );

  const sessionsFor = useCallback(
    (agentId: string) =>
      state.sessions
        .filter((s) => s.agentId === agentId)
        .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt),
    [state.sessions],
  );

  const skillsFor = useCallback((agentId: string) => state.skills[agentId] ?? [], [state.skills]);
  const policyFor = useCallback((agentId: string) => state.policies[agentId] ?? [], [state.policies]);
  const triggersFor = useCallback(
    (agentId: string) => state.triggers.filter((t) => t.agentId === agentId),
    [state.triggers],
  );
  const widgetsFor = useCallback(
    (agentId: string) => state.widgets.filter((w) => w.agentId === agentId),
    [state.widgets],
  );

  return {
    state,
    members: seedMembers,
    pendingApprovals,
    unreadCount,
    sessionsFor,
    skillsFor,
    policyFor,
    triggersFor,
    widgetsFor,
    logAudit,
    recordRun,
    createSession,
    renameSession,
    togglePinSession,
    deleteSession,
    connect,
    disconnect,
    setDecision,
    addRule,
    removeRule,
    resetPolicy,
    addTrigger,
    toggleTrigger,
    deleteTrigger,
    runTrigger,
    tickTriggers,
    decideApproval,
    markNotificationsRead,
    addWidget,
    removeWidget,
    resetOrchestration,
  };
}

/**
 * Evaluate an action against an agent's policy. Exported so the chat layer can
 * gate a real send without importing the whole hook.
 */
export function checkAction(
  agentId: string,
  policies: Record<string, PolicyRule[]>,
  service: string,
  action: string,
) {
  return evaluate({ service, action }, policies[agentId] ?? []);
}
