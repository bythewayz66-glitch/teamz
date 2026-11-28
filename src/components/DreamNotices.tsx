import type { Agent } from '../types';
import type { DreamNotice, DreamReport } from '../lib/dream';
import { timeAgo } from '../lib/agentHome';

interface Props {
  notices: DreamNotice[];
  reports: DreamReport[];
  agentsById: Map<string, Agent>;
  now: number;
  onOpen: (agentId: string) => void;
  onDismiss: (agentId: string) => void;
}

/** One line per agent whose Dream proposed a change. "Nothing to change" Dreams stay quiet. */
export function DreamNotices({ notices, reports, agentsById, now, onOpen, onDismiss }: Props) {
  const unread = notices.filter((n) => !n.read);
  if (unread.length === 0) return null;
  const byAgent = new Map<string, DreamNotice[]>();
  for (const n of unread) byAgent.set(n.agentId, [...(byAgent.get(n.agentId) ?? []), n]);
  return (
    <div className="dream-notices" role="status" aria-label="Dream notices">
      {[...byAgent.entries()].map(([agentId, list]) => {
        const name = agentsById.get(agentId)?.name ?? 'An agent';
        const latest = list[list.length - 1];
        const report = reports.find((r) => r.id === latest.reportId);
        return (
          <div key={agentId} className="dream-notice">
            <span>
              <strong>{name}</strong>’s Dream proposed {report?.proposals.length ?? 'some'} change{report?.proposals.length === 1 ? '' : 's'} {timeAgo(latest.at, now)}.
            </span>
            <span className="dream-notice-actions">
              <button className="btn primary sm" onClick={() => onOpen(agentId)}>Read the report</button>
              <button className="btn ghost sm" onClick={() => onDismiss(agentId)}>Dismiss</button>
            </span>
          </div>
        );
      })}
    </div>
  );
}
