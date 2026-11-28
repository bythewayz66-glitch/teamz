/**
 * useDream — runs the in-tab Dream (scheduled self-review) and holds its
 * persisted record. Each minute it reconciles every enrolled agent's planned
 * slots (`planDreams`), runs what is due one at a time through the same model
 * transport a normal reply uses (`sendToAgent`, with tools off so the reply is
 * the report), and writes the outcome. Nothing runs for an agent until the
 * user switches Dream on for it. Runner-side Dream replies are pinned when
 * the runner snapshot shows them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendToAgent } from '../api/agents';
import { getSettings } from '../api/settings';
import type { Agent, Message, WorkspaceState } from '../types';
import type { RunnerSnapshot } from '../lib/agentHome';
import {
  buildReviewInput,
  disableDream,
  enableDream,
  executeDream,
  ingestRunnerReports,
  markNoticesRead,
  parseDreamState,
  planDreams,
  setDreamCadence,
  EMPTY_DREAM,
  type DreamState,
} from '../lib/dream';

export const DREAM_STORAGE_KEY = 'teamz:dream:v1';
const TICK_MS = 60_000;
const CALL_TIMEOUT_MS = 180_000;

function load(): DreamState {
  try {
    const raw = localStorage.getItem(DREAM_STORAGE_KEY);
    return raw ? parseDreamState(JSON.parse(raw)) : EMPTY_DREAM;
  } catch {
    return EMPTY_DREAM;
  }
}

export interface UseDream {
  state: DreamState;
  /** Agent ids whose Dream is being written right now. */
  running: string[];
  /** Throws a plain-words error when the agent or cadence is not allowed. */
  enable: (agentId: string, cron?: string) => void;
  disable: (agentId: string) => void;
  setCadence: (agentId: string, cron: string) => void;
  markRead: (agentId?: string) => void;
}

export function useDream(workspace: WorkspaceState, runner: RunnerSnapshot | null): UseDream {
  const [state, setStateRaw] = useState<DreamState>(load);
  const stateRef = useRef(state);
  const wsRef = useRef(workspace);
  wsRef.current = workspace;
  const busy = useRef(false);
  const [running, setRunning] = useState<string[]>([]);

  const commit = useCallback((next: DreamState) => {
    stateRef.current = next;
    setStateRaw(next);
    try {
      localStorage.setItem(DREAM_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota: the in-memory copy still serves this tab */
    }
  }, []);

  // Pick up another tab's writes so two tabs do not both run the same slot.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DREAM_STORAGE_KEY || !e.newValue) return;
      try {
        const next = parseDreamState(JSON.parse(e.newValue));
        stateRef.current = next;
        setStateRaw(next);
      } catch {
        /* ignore a half-written value */
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const tick = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const now = Date.now();
      const ws = wsRef.current;
      const live = getSettings().provider !== 'mock';
      const planned = planDreams(stateRef.current, now, {
        providerLive: live,
        activity: (agentId, sinceAt) => {
          const a = ws.agents.find((x) => x.id === agentId);
          if (!a) return { sessions: 0, messages: 0 };
          const r = buildReviewInput(ws, a, sinceAt);
          return { sessions: r.sessionCount, messages: r.messageCount };
        },
      });
      if (planned.state !== stateRef.current) commit(planned.state);
      for (const due of planned.due) {
        // Another tab may have written this slot since we planned.
        const persisted = load();
        if (persisted.records.some((r) => r.agentId === due.agentId && r.slot === due.slot)) {
          commit(persisted);
          continue;
        }
        const agent = ws.agents.find((a) => a.id === due.agentId);
        if (!agent) continue;
        setRunning((r) => [...r, agent.id]);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
        try {
          const review = buildReviewInput(ws, agent, due.sinceAt);
          const result = await executeDream({
            state: stateRef.current,
            due,
            agent,
            review,
            now: Date.now,
            send: (prompt) => askAgent(agent, prompt, ws, controller.signal),
          });
          commit(result.state);
        } finally {
          clearTimeout(timer);
          setRunning((r) => r.filter((id) => id !== agent.id));
        }
      }
    } finally {
      busy.current = false;
    }
  }, [commit]);

  useEffect(() => {
    void tick();
    const t = setInterval(() => void tick(), TICK_MS);
    return () => clearInterval(t);
  }, [tick]);

  // Pin the runner's own Dream replies.
  useEffect(() => {
    if (!runner) return;
    const next = ingestRunnerReports(stateRef.current, runner.channelMessages);
    if (next !== stateRef.current) commit(next);
  }, [runner, commit]);

  const enable = useCallback((agentId: string, cron?: string) => {
    commit(enableDream(stateRef.current, agentId, Date.now(), cron));
    void tick();
  }, [commit, tick]);
  const disable = useCallback((agentId: string) => commit(disableDream(stateRef.current, agentId)), [commit]);
  const setCadence = useCallback((agentId: string, cron: string) => commit(setDreamCadence(stateRef.current, agentId, cron, Date.now())), [commit]);
  const markRead = useCallback((agentId?: string) => commit(markNoticesRead(stateRef.current, agentId)), [commit]);

  return useMemo(() => ({ state, running, enable, disable, setCadence, markRead }), [state, running, enable, disable, setCadence, markRead]);
}

/** One plain model call: no tools, one user message, the agent's own instructions apply. */
function askAgent(agent: Agent, prompt: string, ws: WorkspaceState, signal: AbortSignal): Promise<string> {
  const message: Message = {
    id: `dream-${Date.now()}`,
    conversationId: `dream:${agent.id}`,
    authorType: 'user',
    text: prompt,
    createdAt: Date.now(),
    status: 'sent',
  };
  const toolless: Agent = { ...agent, enabledTools: [] };
  const byId = new Map(ws.agents.map((a) => [a.id, a]));
  byId.set(agent.id, toolless);
  return sendToAgent(toolless, [message], byId, {
    conversationId: `dream:${agent.id}`,
    conversationName: 'Dream',
    conversationKind: 'direct',
    signal,
  });
}
