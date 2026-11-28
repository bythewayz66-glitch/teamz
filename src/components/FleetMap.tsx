import { useMemo, useState } from 'react';
import type { Agent } from '../types';
import { Modal } from './Modal';
import type { EdgeRelation, EdgeState, FleetGraph, GraphEdge, GraphNode } from '../lib/graph';
import { buildSections } from '../lib/sections';
import { timeAgo } from '../lib/agentHome';

type Tab = 'graph' | 'edges' | 'sections';

interface Props {
  open: boolean;
  onClose: () => void;
  graph: FleetGraph;
  agents: Agent[];
  onOpenAgentHome: (agentId: string) => void;
}

const RELATION_LABEL: Record<EdgeRelation, string> = {
  mention: '@mention',
  handoff: 'job handoff',
  model: 'model calls',
  push: 'GitHub push',
  web: 'web tools',
};
const STATE_LABEL: Record<EdgeState, string> = { active: 'Active', dead: 'Dead (0 calls)', unknown: 'Not recorded' };

const SIZE = 1000;
const CENTER = SIZE / 2;

interface Layout {
  pos: Map<string, { x: number; y: number }>;
  clusters: Array<{ id: string; label: string; x: number; y: number; r: number }>;
}

/** Programme clusters on a ring, agents in a spiral inside each, integrations in the middle. */
function layout(nodes: GraphNode[], agents: Agent[]): Layout {
  const sections = buildSections(agents);
  const pos = new Map<string, { x: number; y: number }>();
  const clusters: Layout['clusters'] = [];
  const ring = 335;
  sections.forEach((sec, i) => {
    const ang = (i / sections.length) * Math.PI * 2 - Math.PI / 2;
    const cx = CENTER + Math.cos(ang) * ring;
    const cy = CENTER + Math.sin(ang) * ring;
    const r = 26 + Math.sqrt(sec.agents.length) * 17;
    clusters.push({ id: sec.id, label: sec.label, x: cx, y: cy, r });
    sec.agents.forEach((a, k) => {
      const golden = k * 2.399963;
      const rr = Math.sqrt((k + 0.5) / sec.agents.length) * (r - 8);
      pos.set(a.id, { x: cx + Math.cos(golden) * rr, y: cy + Math.sin(golden) * rr });
    });
  });
  const ints = nodes.filter((n) => n.kind === 'integration');
  ints.forEach((n, i) => {
    const ang = (i / Math.max(ints.length, 1)) * Math.PI * 2 - Math.PI / 2;
    const rr = ints.length === 1 ? 0 : 70;
    pos.set(n.id, { x: CENTER + Math.cos(ang) * rr, y: CENTER + Math.sin(ang) * rr });
  });
  return { pos, clusters };
}

function GraphSvg({ graph, agents, selected, onSelect, showDeclared }: { graph: FleetGraph; agents: Agent[]; selected: string | null; onSelect: (id: string | null) => void; showDeclared: boolean }) {
  const lay = useMemo(() => layout(graph.nodes, agents), [graph.nodes, agents]);
  const maxActivity = Math.max(1, ...graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.activity));
  const maxEdge = Math.max(1, ...graph.edges.map((e) => e.count ?? 0));
  const touches = (e: GraphEdge) => selected !== null && (e.from === selected || e.to === selected);

  const visible = graph.edges.filter((e) => {
    if (selected !== null) return touches(e) && (showDeclared || e.state !== 'unknown');
    if (e.kind === 'integration') return e.state === 'active';
    return e.state !== 'unknown' && (e.state === 'active' || e.count === 0);
  });

  return (
    <svg className="fleet-svg" viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Fleet graph: programmes as clusters, calls as lines" onClick={() => onSelect(null)}>
      {lay.clusters.map((c) => (
        <g key={c.id}>
          <circle cx={c.x} cy={c.y} r={c.r} className="fleet-cluster" />
          <text x={c.x} y={c.y - c.r - 8} textAnchor="middle" className="fleet-cluster-label">{c.label}</text>
        </g>
      ))}
      {visible.map((e) => {
        const a = lay.pos.get(e.from);
        const b = lay.pos.get(e.to);
        if (!a || !b) return null;
        const w = e.state === 'active' ? 0.8 + (Math.log1p(e.count ?? 0) / Math.log1p(maxEdge)) * 3.2 : 1;
        return (
          <line
            key={e.id}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            className={`fleet-edge is-${e.state}${e.kind === 'integration' ? ' is-int' : ''}${touches(e) ? ' is-sel' : ''}`}
            strokeWidth={w}
          />
        );
      })}
      {graph.nodes.map((n) => {
        const p = lay.pos.get(n.id);
        if (!p) return null;
        if (n.kind === 'integration') {
          return (
            <g key={n.id} onClick={(ev) => { ev.stopPropagation(); onSelect(n.id); }} className="fleet-int">
              <rect x={p.x - 46} y={p.y - 13} width={92} height={26} rx={7} className={selected === n.id ? 'is-sel' : ''} />
              <text x={p.x} y={p.y + 4} textAnchor="middle">{n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}</text>
            </g>
          );
        }
        const r = 3 + (n.activity / maxActivity) * 7;
        return (
          <circle
            key={n.id}
            cx={p.x} cy={p.y} r={r}
            className={`fleet-node is-${n.health}${selected === n.id ? ' is-sel' : ''}`}
            onClick={(ev) => { ev.stopPropagation(); onSelect(n.id); }}
          >
            <title>{`${n.label}: ${n.activity} call${n.activity === 1 ? '' : 's'} in ${graph.windowDays} days${n.health === 'zero' ? ' (none)' : n.health === 'unknown' ? ' (cannot be sure)' : ''}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

function agentName(graph: FleetGraph, id: string): string {
  return graph.nodes.find((n) => n.id === id)?.label ?? id;
}

export function FleetMap({ open, onClose, graph, agents, onOpenAgentHome }: Props) {
  const [tab, setTab] = useState<Tab>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 860px)').matches ? 'edges' : 'graph'));
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<'all' | EdgeState>('all');
  const [relation, setRelation] = useState<'all' | EdgeRelation>('all');
  const [showDeclared, setShowDeclared] = useState(false);
  const sections = useMemo(() => buildSections(agents), [agents]);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const edgeRows = useMemo(
    () =>
      graph.edges.filter(
        (e) => (state === 'all' || e.state === state) && (relation === 'all' || e.relation === relation) && (selected === null || e.from === selected || e.to === selected),
      ),
    [graph.edges, state, relation, selected],
  );

  const sel = selected ? byId.get(selected) ?? null : null;
  const noEvidence = graph.sources.every((s) => !s.coversWindow);

  return (
    <Modal open={open} onClose={onClose} title="Fleet map" subtitle={`Who called whom in the last ${graph.windowDays} days, and what leaves Teamz`} width={1080}>
      <div className="fleet-map">
        <section className="fleet-summary" aria-label="Fleet summary">
          <div>
            <h3>Busiest three</h3>
            {graph.busiest.length === 0 ? (
              <p className="lib-muted">No recorded calls yet.</p>
            ) : (
              <ol>
                {graph.busiest.map((n) => (
                  <li key={n.id}>
                    <button className="link-btn" onClick={() => onOpenAgentHome(n.id)}>{n.label}</button>
                    <span> {n.activity} calls · {n.breakdown.modelCalls} model, {n.breakdown.mentionsIn + n.breakdown.mentionsOut} mentions, {n.breakdown.handoffsIn + n.breakdown.handoffsOut} handoffs</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <h3>No calls in {graph.windowDays} days</h3>
            {graph.zeroCall.length === 0 ? (
              <p className="lib-muted">
                {graph.unknownHealth.length > 0 ? `None can be proven: ${graph.unknownHealth.length} agents have no source that reaches back ${graph.windowDays} days yet.` : 'Every agent made a call.'}
              </p>
            ) : (
              <details className="fleet-zero" open={graph.zeroCall.length <= 8}>
                <summary>{graph.zeroCall.length} agent{graph.zeroCall.length === 1 ? '' : 's'}</summary>
                <p>
                  {graph.zeroCall.map((n, i) => (
                    <span key={n.id}>
                      {i > 0 && ', '}
                      <button className="link-btn" onClick={() => onOpenAgentHome(n.id)}>{n.label}</button>
                    </span>
                  ))}
                </p>
              </details>
            )}
          </div>
        </section>

        <details className="fleet-sources" open={noEvidence}>
          <summary>Where these numbers come from{noEvidence ? ' (no source reaches back far enough yet)' : ''}</summary>
          <ul>
            {graph.sources.map((s) => (
              <li key={s.id}>
                <strong>{s.label}</strong>:{' '}
                {s.from === null ? 'nothing recorded' : `back to ${new Date(s.from).toISOString().slice(0, 10)}`} ·{' '}
                {s.coversWindow ? `reaches the ${graph.windowDays}-day window` : `does not reach ${graph.windowDays} days, so no edge can be called dead from it`}. {s.note}
              </li>
            ))}
            <li><strong>Web tools</strong>: declared by the runner’s toolset; no source records per-agent calls, so these edges are never counted.</li>
          </ul>
        </details>

        <div className="lib-tabs" role="tablist" aria-label="Fleet map views">
          {(['graph', 'edges', 'sections'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`lib-tab${tab === t ? ' is-active' : ''}${t === 'graph' ? ' fleet-graph-tab' : ''}`} onClick={() => setTab(t)}>
              {t === 'graph' ? 'Graph' : t === 'edges' ? 'Edges' : 'Sections'}
            </button>
          ))}
        </div>

        {sel && (
          <p className="fleet-sel" role="status">
            <strong>{sel.label}</strong>{sel.kind === 'agent' && sel.programme ? ` · ${sel.programme}` : ''} — {sel.activity} calls in {graph.windowDays} days.{' '}
            {sel.kind === 'agent' && <button className="link-btn" onClick={() => onOpenAgentHome(sel.id)}>Open home</button>}{' '}
            <button className="link-btn" onClick={() => setSelected(null)}>Clear</button>
          </p>
        )}

        {tab === 'graph' && (
          <div className="fleet-graph-wrap">
            <p className="fleet-graph-note" id="fleet-graph-mobile-note">The graph needs a wider screen. Use <button className="link-btn" onClick={() => setTab('edges')}>Edges</button> for the same data as a table.</p>
            <GraphSvg graph={graph} agents={agents} selected={selected} onSelect={setSelected} showDeclared={showDeclared} />
            <div className="fleet-legend">
              <span><i className="lg lg-active" /> active</span>
              <span><i className="lg lg-dead" /> dead: source covers the window, 0 calls</span>
              <span><i className="lg lg-zero" /> agent, no calls</span>
              <label><input type="checkbox" checked={showDeclared} onChange={(e) => setShowDeclared(e.target.checked)} /> show declared, uncounted edges for the selection</label>
            </div>
          </div>
        )}

        {tab === 'edges' && (
          <div>
            <div className="fleet-filters">
              <label>State <select value={state} onChange={(e) => setState(e.target.value as 'all' | EdgeState)}><option value="all">All</option><option value="active">Active</option><option value="dead">Dead</option><option value="unknown">Not recorded</option></select></label>
              <label>Kind <select value={relation} onChange={(e) => setRelation(e.target.value as 'all' | EdgeRelation)}><option value="all">All</option>{(Object.keys(RELATION_LABEL) as EdgeRelation[]).map((r) => <option key={r} value={r}>{RELATION_LABEL[r]}</option>)}</select></label>
              <span className="lib-muted">{edgeRows.length} edge{edgeRows.length === 1 ? '' : 's'}</span>
            </div>
            <div className="fleet-table-wrap">
              <table className="fleet-table">
                <thead><tr><th>From</th><th>To</th><th>Kind</th><th>{graph.windowDays}d calls</th><th>Last</th><th>State</th></tr></thead>
                <tbody>
                  {edgeRows.slice(0, 300).map((e) => (
                    <tr key={e.id} className={`is-${e.state}`}>
                      <td>{agentName(graph, e.from)}</td>
                      <td>{agentName(graph, e.to)}</td>
                      <td>{RELATION_LABEL[e.relation]}</td>
                      <td>{e.count === null ? '—' : e.count}</td>
                      <td>{e.lastAt ? timeAgo(e.lastAt, graph.now) : '—'}</td>
                      <td><span className={`edge-state is-${e.state}`}>{STATE_LABEL[e.state]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {edgeRows.length > 300 && <p className="lib-muted">Showing the first 300 of {edgeRows.length}; narrow with the filters.</p>}
          </div>
        )}

        {tab === 'sections' && (
          <div className="fleet-sections">
            {sections.map((s) => {
              const total = s.agents.reduce((n, a) => n + (byId.get(a.id)?.activity ?? 0), 0);
              return (
                <section key={s.id} className="fleet-section">
                  <h3>{s.label} <span className="count">{s.agents.length}</span></h3>
                  <p className="lib-muted">{s.blurb} {total} calls in {graph.windowDays} days.</p>
                  <ul className="chip-list">
                    {s.agents.map((a) => {
                      const n = byId.get(a.id);
                      return (
                        <li key={a.id}>
                          <button className={`chip-btn is-${n?.health ?? 'unknown'}`} onClick={() => onOpenAgentHome(a.id)} title={`${n?.activity ?? 0} calls in ${graph.windowDays} days`}>
                            {a.name}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
            <p className="lib-muted">Programmes are a declared grouping of the fleet by role; the runner has no programme field. See docs/GRAPH.md.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
