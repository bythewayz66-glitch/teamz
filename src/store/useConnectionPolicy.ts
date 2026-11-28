import { useCallback, useState } from 'react';
import { CONNECTION_POLICY_KEY, parsePolicies, policyKey, type ConnectionRow, type PolicyMap, type PolicyValue } from '../lib/connections';

export interface UseConnectionPolicy {
  policies: PolicyMap;
  setPolicy: (agentId: string, rowId: ConnectionRow['id'], value: PolicyValue) => void;
}

/** Declared (advisory) connection policies, kept in this browser only. */
export function useConnectionPolicy(): UseConnectionPolicy {
  const [policies, setPolicies] = useState<PolicyMap>(() => {
    try {
      return parsePolicies(localStorage.getItem(CONNECTION_POLICY_KEY));
    } catch {
      return {};
    }
  });
  const setPolicy = useCallback((agentId: string, rowId: ConnectionRow['id'], value: PolicyValue) => {
    setPolicies((prev) => {
      const next = { ...prev, [policyKey(agentId, rowId)]: value };
      try {
        localStorage.setItem(CONNECTION_POLICY_KEY, JSON.stringify(next));
      } catch {
        /* storage full — the in-memory choice still applies this session */
      }
      return next;
    });
  }, []);
  return { policies, setPolicy };
}
