import { useMemo, useRef, useState } from 'react';
import type { Agent } from '../types';
import { Modal } from './Modal';
import { AgentAvatar } from './Avatar';
import type { UseLibrary } from '../store/useLibrary';
import {
  currentVersion,
  diffVersions,
  findVersion,
  instantiationBlock,
  type Bump,
  type LibraryTemplate,
  type TemplateDiff,
} from '../lib/library';
import { diffBundleReleases, getLibraryBundles } from '../lib/skillLibrary';
import { getAllSkills, getSkillByKey } from '../data/templates/skills';

type Tab = 'templates' | 'skills';
type Filter = 'all' | 'fleet' | 'published' | 'imported' | 'review';

const SOURCE_LABEL: Record<LibraryTemplate['source']['kind'], string> = {
  'teamz-fleet': 'Teamz fleet',
  published: 'Published here',
  'gamut-import': 'Gamut import',
};

const REVIEW_LABEL: Record<LibraryTemplate['review']['status'], string> = {
  builtin: 'Shipped with Teamz',
  unreviewed: 'Awaiting the Reviewer',
  approved: 'Approved by the Reviewer',
  rejected: 'Rejected by the Reviewer',
};

interface Props {
  open: boolean;
  onClose: () => void;
  library: UseLibrary;
  agents: Agent[];
  onCreate: (t: LibraryTemplate) => { ok: true } | { ok: false; reason: string };
}

function DiffView({ diff }: { diff: TemplateDiff }) {
  if (diff.changes.length === 0) return <p className="lib-muted">No differences between {diff.from} and {diff.to}.</p>;
  return (
    <div className="lib-diff" aria-label={`Changes from ${diff.from} to ${diff.to}`}>
      {diff.changes.map((c) => (
        <div key={c.field} className="lib-diff-row">
          <strong>{c.label}</strong>
          {c.lines ? (
            <div>
              <span className="lib-muted">
                {c.lines.added.length} line{c.lines.added.length === 1 ? '' : 's'} added, {c.lines.removed.length} removed,{' '}
                {c.lines.unchanged} unchanged
              </span>
              <pre className="lib-pre">
                {c.lines.removed.slice(0, 12).map((l) => `− ${l}\n`).join('')}
                {c.lines.added.slice(0, 12).map((l) => `+ ${l}\n`).join('')}
              </pre>
            </div>
          ) : (
            <pre className="lib-pre">
              {c.field === 'needs' || c.field === 'runnerTools' || c.field === 'skillKeys'
                ? c.after
                : `${c.before}\n→ ${c.after}`}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function TemplateCard({ t, lib, onCreate }: { t: LibraryTemplate; lib: UseLibrary; onCreate: Props['onCreate'] }) {
  const [open, setOpen] = useState(false);
  const [fromSel, setFrom] = useState<string | null>(null);
  const [toSel, setTo] = useState<string | null>(null);
  const [by, setBy] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const cur = currentVersion(t);
  const from = fromSel ?? t.versions[Math.max(0, t.versions.length - 2)].version;
  const to = toSel ?? cur.version;
  const c = cur.content;
  const block = instantiationBlock(t);
  const a = findVersion(t, from);
  const b = findVersion(t, to);
  const diff = useMemo(() => (a && b ? diffVersions(a, b) : null), [a, b]);
  const custom = t.source.kind !== 'teamz-fleet';

  return (
    <article className="lib-card" data-template={t.id}>
      <header className="lib-card-head">
        <AgentAvatar agent={{ name: t.name, emoji: c.emoji, accent: c.accent }} size={40} />
        <div className="lib-card-title">
          <h3>
            {t.name} <span className="lib-ver">v{cur.version}</span>
          </h3>
          <p>{c.summary}</p>
          <p className="lib-badges">
            <span className="lib-badge">{SOURCE_LABEL[t.source.kind]}</span>
            <span className={`lib-badge is-${t.review.status}`}>{REVIEW_LABEL[t.review.status]}</span>
          </p>
        </div>
        <div className="lib-card-actions">
          <button
            className="btn primary sm"
            disabled={block !== null}
            title={block ?? 'Create this agent with its first session'}
            onClick={() => {
              const r = onCreate(t);
              setMsg(r.ok ? null : r.reason);
            }}
          >
            Create agent
          </button>
          <button className="btn ghost sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Hide details' : 'Details'}
          </button>
        </div>
      </header>
      {block && <p className="lib-note">{block}</p>}
      {msg && <p className="lib-note is-error" role="alert">{msg}</p>}

      {open && (
        <div className="lib-body">
          <div className="lib-cols">
            <section>
              <h4>What it needs</h4>
              <ul>{c.needs.map((n) => <li key={n}>{n}</li>)}</ul>
            </section>
            <section>
              <h4>What is inside</h4>
              <ul>
                <li>System prompt, {c.systemPrompt.length.toLocaleString()} characters</li>
                <li>Model: {c.model}</li>
                {c.maxIterations !== null && <li>Iteration budget: {c.maxIterations}</li>}
                {c.skillKeys.length > 0 && <li>Skills: {c.skillKeys.map((k) => getSkillByKey(k).name).join(', ')}</li>}
                <li>
                  First job: {c.firstJob ? `“${c.firstJob.title}” (${c.firstJob.kind}${c.firstJob.schedule ? `, cron ${c.firstJob.schedule}` : ''})` : 'none on record'}
                </li>
                {t.imported && (
                  <>
                    <li>{t.imported.files.length} files in the archive; only the instructions and skill names are kept</li>
                    {t.imported.skills.length > 0 && <li>Gamut skills: {t.imported.skills.map((s) => s.name).join(', ')}</li>}
                  </>
                )}
              </ul>
            </section>
          </div>
          <p className="lib-muted">
            Source:{' '}
            {t.source.kind === 'teamz-fleet'
              ? `${t.source.agentFile} (agent ${t.source.agentId})${t.source.firstJobFile ? `; first job from ${t.source.firstJobFile}` : ''}`
              : t.source.kind === 'published'
                ? `published from the agent “${t.source.fromAgentName}” in this workspace`
                : `${t.source.filename}, ${t.source.instructionsPath}, archive SHA-256 ${t.source.archiveSha256.slice(0, 12)}…`}
          </p>

          <h4>Versions</h4>
          <ol className="lib-versions">
            {[...t.versions].reverse().map((v) => (
              <li key={v.version}>
                <strong>{v.version}</strong> · {new Date(v.publishedAt).toISOString().slice(0, 10)} · {v.note}
              </li>
            ))}
          </ol>
          {t.versions.length > 1 ? (
            <div className="lib-compare">
              <label>
                Compare{' '}
                <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From version">
                  {t.versions.map((v) => <option key={v.version}>{v.version}</option>)}
                </select>
              </label>
              <label>
                with{' '}
                <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To version">
                  {t.versions.map((v) => <option key={v.version}>{v.version}</option>)}
                </select>
              </label>
              {diff && <DiffView diff={diff} />}
            </div>
          ) : (
            <p className="lib-muted">One version so far. A second appears when this template is published again with changes.</p>
          )}

          {custom && (
            <div className="lib-review">
              <h4>The Reviewer’s decision</h4>
              {t.review.status !== 'unreviewed' && t.review.by && (
                <p className="lib-muted">
                  {REVIEW_LABEL[t.review.status]} — recorded by {t.review.by}: {t.review.note}
                </p>
              )}
              <p className="lib-muted">
                Teamz cannot check who is typing. This records the Reviewer’s decision; it does not make one.
              </p>
              <div className="lib-form-row">
                <input value={by} onChange={(e) => setBy(e.target.value)} placeholder="Recorded by" aria-label="Recorded by" />
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason" aria-label="Reason" />
              </div>
              <div className="lib-form-row">
                {(['approved', 'rejected'] as const).map((d) => (
                  <button
                    key={d}
                    className="btn ghost sm"
                    onClick={() => setMsg(lib.review(t.id, d, by, note))}
                  >
                    Record {d === 'approved' ? 'approval' : 'rejection'}
                  </button>
                ))}
                <button className="btn ghost sm" onClick={() => lib.remove(t.id)}>
                  Remove from library
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function PublishForm({ lib, agents }: { lib: UseLibrary; agents: Agent[] }) {
  const [agentId, setAgentId] = useState('');
  const [bump, setBump] = useState<Bump>('minor');
  const [note, setNote] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [jobPrompt, setJobPrompt] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const agent = agents.find((a) => a.id === agentId);
  const existing = lib.state.custom.find((t) => t.source.kind === 'published' && t.source.fromAgentId === agentId);

  return (
    <details className="lib-publish">
      <summary>Publish an agent from this workspace</summary>
      <div className="lib-form">
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent to publish">
          <option value="">Choose an agent…</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        {agent && (
          <p className="lib-muted">
            {existing ? `Adds the next version of “${existing.name}” (now v${currentVersion(existing).version}).` : 'Creates a new template at v1.0.0.'}
          </p>
        )}
        {existing && (
          <select value={bump} onChange={(e) => setBump(e.target.value as Bump)} aria-label="Version bump">
            <option value="patch">Patch</option>
            <option value="minor">Minor</option>
            <option value="major">Major</option>
          </select>
        )}
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed in this version?" aria-label="Version note" />
        <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="First job title (optional)" aria-label="First job title" />
        <textarea value={jobPrompt} onChange={(e) => setJobPrompt(e.target.value)} rows={3} placeholder="First job prompt (optional)" aria-label="First job prompt" />
        <button
          className="btn primary sm"
          disabled={!agent}
          onClick={() => {
            if (!agent) return;
            const firstJob = jobTitle.trim() && jobPrompt.trim()
              ? { title: jobTitle.trim(), prompt: jobPrompt.trim(), kind: 'one-off' as const, schedule: null }
              : null;
            const r = lib.publish(agent, { bump, note, existingId: existing?.id, firstJob });
            setMsg(r.ok ? { ok: true, text: `Published v${currentVersion(r.template).version}. It waits for the Reviewer before anyone can use it.` } : { ok: false, text: r.reason });
          }}
        >
          Publish
        </button>
        {msg && <p className={`lib-note${msg.ok ? '' : ' is-error'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      </div>
    </details>
  );
}

function SkillsTab() {
  const bundles = useMemo(getLibraryBundles, []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  const total = new Set(bundles.flatMap((x) => x.bundle.skillKeys)).size;
  return (
    <div>
      <p className="lib-muted">
        {bundles.length} bundles cover {total} of the registry’s {getAllSkills().length} skills; the rest can still be picked one by one in the wizard. Every bundle is versioned: a change to a skill needs a new release recorded here.
      </p>
      {bundles.map(({ bundle, releases, current, drifted }) => (
        <article key={bundle.id} className="lib-card" data-bundle={bundle.id}>
          <header className="lib-card-head">
            <div className="lib-card-title">
              <h3>
                {bundle.name} <span className="lib-ver">v{current.version}</span>
              </h3>
              <p>{bundle.description}</p>
              <p className="lib-badges">
                <span className="lib-badge">{bundle.skillKeys.length} skills</span>
                {drifted && <span className="lib-badge is-rejected">Changed since v{current.version}</span>}
              </p>
            </div>
            <button
              className="btn ghost sm"
              aria-expanded={openId === bundle.id}
              onClick={() => {
                setOpenId(openId === bundle.id ? null : bundle.id);
                setA(0);
                setB(releases.length - 1);
              }}
            >
              {openId === bundle.id ? 'Hide' : 'Details'}
            </button>
          </header>
          {openId === bundle.id && (
            <div className="lib-body">
              <ul>
                {bundle.skillKeys.map((k) => {
                  const s = getSkillByKey(k);
                  return <li key={k}><strong>{s.name}</strong> — {s.description}</li>;
                })}
              </ul>
              <h4>Releases</h4>
              <ol className="lib-versions">
                {[...releases].reverse().map((r) => <li key={r.version}><strong>{r.version}</strong> · {r.released} · {r.note}</li>)}
              </ol>
              {releases.length > 1 ? (
                <div className="lib-compare">
                  <select value={a} onChange={(e) => setA(Number(e.target.value))} aria-label="From release">
                    {releases.map((r, i) => <option key={r.version} value={i}>{r.version}</option>)}
                  </select>
                  <select value={b} onChange={(e) => setB(Number(e.target.value))} aria-label="To release">
                    {releases.map((r, i) => <option key={r.version} value={i}>{r.version}</option>)}
                  </select>
                  {(() => {
                    const d = diffBundleReleases(releases[a], releases[b]);
                    return (
                      <pre className="lib-pre">
                        {d.addedSkills.map((k) => `+ ${getSkillByKey(k).name}\n`).join('')}
                        {d.removedSkills.map((k) => `− ${getSkillByKey(k).name}\n`).join('')}
                        {d.wordingChanged ? 'Same skills, wording changed.\n' : ''}
                        {!d.addedSkills.length && !d.removedSkills.length && !d.wordingChanged ? 'No differences.' : ''}
                      </pre>
                    );
                  })()}
                </div>
              ) : (
                <p className="lib-muted">One release so far; there is nothing to compare yet.</p>
              )}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export function LibraryPanel({ open, onClose, library, agents, onCreate }: Props) {
  const [tab, setTab] = useState<Tab>('templates');
  const [filter, setFilter] = useState<Filter>('all');
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const shown = library.templates.filter((t) => {
    if (filter === 'fleet') return t.source.kind === 'teamz-fleet';
    if (filter === 'published') return t.source.kind === 'published';
    if (filter === 'imported') return t.source.kind === 'gamut-import';
    if (filter === 'review') return t.review.status === 'unreviewed';
    return true;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Team Library"
      subtitle="Templates proven in the fleet, versioned skill bundles, and anything published or imported — behind the Reviewer."
      width={860}
    >
      <div className="tabs" role="tablist" aria-label="Library sections">
        {(['templates', 'skills'] as const).map((k) => (
          <button key={k} className={`tab${tab === k ? ' is-on' : ''}`} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {k === 'templates' ? 'Templates' : 'Skills'}
          </button>
        ))}
      </div>

      {tab === 'templates' ? (
        <>
          <div className="lib-toolbar">
            {(['all', 'fleet', 'published', 'imported', 'review'] as const).map((f) => (
              <button key={f} className={`filter-chip${filter === f ? ' is-on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {{ all: 'All', fleet: 'Teamz fleet', published: 'Published', imported: 'Imported', review: 'Awaiting review' }[f]}
              </button>
            ))}
          </div>
          <div className="lib-import">
            <input
              ref={fileRef}
              type="file"
              accept=".agent,application/zip"
              aria-label="Import a Gamut agent file"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                const r = await library.importAgentFile(file);
                setImportMsg(
                  r.ok
                    ? { ok: true, text: `Imported “${r.template.name}” as a template. It waits for the Reviewer; it is not an agent.` }
                    : { ok: false, text: r.reason },
                );
              }}
            />
            <span className="lib-muted">Gamut <code>.agent</code> file, imported as a template and never into the live fleet. Not yet checked against a file made by Gamut’s own export.</span>
            {importMsg && <p className={`lib-note${importMsg.ok ? '' : ' is-error'}`} role={importMsg.ok ? 'status' : 'alert'}>{importMsg.text}</p>}
          </div>
          <PublishForm lib={library} agents={agents} />
          {shown.length === 0 ? <p className="lib-muted">Nothing here yet.</p> : shown.map((t) => <TemplateCard key={t.id} t={t} lib={library} onCreate={onCreate} />)}
        </>
      ) : (
        <SkillsTab />
      )}
    </Modal>
  );
}
