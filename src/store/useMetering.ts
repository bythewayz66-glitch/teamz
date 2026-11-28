import { useCallback, useEffect, useState } from 'react';
import {
  METERING_KEY,
  decideBudget,
  decidePacing,
  parseMetering,
  proposeBudget,
  proposePacing,
  emptyMetering,
  type BudgetProposal,
  type MeteringState,
  type ProviderCredit,
} from '../lib/metering';

type Err = string | null;

export interface UseMetering {
  state: MeteringState;
  setCredit: (c: ProviderCredit) => void;
  removeCredit: (provider: string) => void;
  propose: (input: Omit<BudgetProposal, 'id' | 'proposedAt' | 'status' | 'decision'>) => Err;
  decide: (id: string, decision: 'approved' | 'rejected', by: string, note: string) => Err;
  removeBudget: (id: string) => void;
  proposeGap: (gapMs: number, note: string) => Err;
  decideGap: (id: string, decision: 'approved' | 'rejected', by: string, note: string) => Err;
}

/** Credits, budget proposals and pacing proposals, kept in this browser only. Nothing here writes to the runner. */
export function useMetering(): UseMetering {
  const [state, setState] = useState<MeteringState>(() => {
    try {
      return parseMetering(localStorage.getItem(METERING_KEY));
    } catch {
      return emptyMetering();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(METERING_KEY, JSON.stringify(state));
    } catch {
      /* storage full — the in-memory copy still serves this session */
    }
  }, [state]);

  const guard = useCallback((fn: () => void): Err => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'Could not record that.';
    }
  }, []);

  const setCredit = useCallback((c: ProviderCredit) => setState((s) => ({ ...s, credits: [...s.credits.filter((x) => x.provider !== c.provider), c] })), []);
  const removeCredit = useCallback((provider: string) => setState((s) => ({ ...s, credits: s.credits.filter((x) => x.provider !== provider) })), []);
  const propose = useCallback<UseMetering['propose']>((input) => guard(() => {
    const b = proposeBudget(input, Date.now());
    setState((s) => ({ ...s, budgets: [...s.budgets, b] }));
  }), [guard]);
  const decide = useCallback<UseMetering['decide']>((id, decision, by, note) => {
    const b = state.budgets.find((x) => x.id === id);
    if (!b) return 'No such budget.';
    return guard(() => {
      const next = decideBudget(b, decision, by, note, Date.now());
      setState((s) => ({ ...s, budgets: s.budgets.map((x) => (x.id === id ? next : x)) }));
    });
  }, [state.budgets, guard]);
  const removeBudget = useCallback((id: string) => setState((s) => ({ ...s, budgets: s.budgets.filter((x) => x.id !== id) })), []);
  const proposeGap = useCallback<UseMetering['proposeGap']>((gapMs, note) => guard(() => {
    const p = proposePacing(gapMs, note, Date.now());
    setState((s) => ({ ...s, pacing: [...s.pacing, p] }));
  }), [guard]);
  const decideGap = useCallback<UseMetering['decideGap']>((id, decision, by, note) => {
    const p = state.pacing.find((x) => x.id === id);
    if (!p) return 'No such proposal.';
    return guard(() => {
      const next = decidePacing(p, decision, by, note, Date.now());
      setState((s) => ({ ...s, pacing: s.pacing.map((x) => (x.id === id ? next : x)) }));
    });
  }, [state.pacing, guard]);

  return { state, setCredit, removeCredit, propose, decide, removeBudget, proposeGap, decideGap };
}
