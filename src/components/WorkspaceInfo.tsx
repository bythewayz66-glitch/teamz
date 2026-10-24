import { useEffect, useState } from 'react';
import { Modal, Field } from './Modal';
import { RefreshIcon } from './Icons';
import { useLlmSettings } from '../store/useLlmSettings';
import type { LlmSettings, Provider } from '../api/settings';
import {
  DEFAULT_ANON_MODEL,
  DEFAULT_KEYED_MODEL,
  callPollinations,
  hasKey,
  listPollinationsModels,
  resolveModel,
  buildPollinationsRequest,
  type ModelOption,
} from '../api/pollinations';

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: 'pollinations', label: 'Pollinations' },
  { id: 'custom', label: 'Own endpoints' },
  { id: 'mock', label: 'Mock' },
];

/** Provider / model / key form. Saves to localStorage on "Save". */
function ProviderSettings() {
  const [saved, save] = useLlmSettings();
  const [draft, setDraft] = useState<LlmSettings>(saved);
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => setDraft(saved), [saved]);

  const keyed = hasKey(draft);
  useEffect(() => {
    if (draft.provider !== 'pollinations') return;
    let live = true;
    listPollinationsModels(draft).then((m) => live && setModels(m));
    return () => {
      live = false;
    };
    // Re-fetch only when the tier changes, not on every keystroke.
  }, [draft.provider, keyed]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const patch = (p: Partial<LlmSettings>) => {
    setDraft((d) => ({ ...d, ...p }));
    setTest(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    const started = performance.now();
    try {
      const req = buildPollinationsRequest(
        { id: 'test', name: 'Test', emoji: '', accent: '', status: 'online', endpointUrl: '', model: '', systemPrompt: 'You are a connection test.', skills: [], createdAt: 0 },
        [{ id: 't', conversationId: 't', authorType: 'user', text: 'Reply with the single word: pong', createdAt: Date.now(), status: 'sent' }],
        new Map(),
        { conversationKind: 'direct', conversationName: 'test' },
        { ...draft, stream: false },
      );
      const reply = await callPollinations(req);
      setTest({ ok: true, text: `${resolveModel(draft)} replied “${reply.trim().slice(0, 60)}” · ${Math.round(performance.now() - started)}ms` });
    } catch (err) {
      setTest({ ok: false, text: err instanceof Error ? err.message : 'Request failed' });
    } finally {
      setTesting(false);
    }
  };

  const defaultModel = keyed ? DEFAULT_KEYED_MODEL : DEFAULT_ANON_MODEL;

  return (
    <div className="info-block">
      <h3>AI provider</h3>
      <div className="seg" style={{ marginBottom: 12 }}>
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={draft.provider === p.id ? 'is-on' : ''}
            onClick={() => patch({ provider: p.id })}
          >
            {p.label}
          </button>
        ))}
      </div>

      {draft.provider === 'pollinations' && (
        <>
          <p className="muted">
            Real replies from <a href="https://pollinations.ai" target="_blank" rel="noreferrer">Pollinations.ai</a>.
            Each agent’s system prompt, role and skills become the persona; recent chat history is sent as context.
            Without a key you use the free anonymous tier (<code>{DEFAULT_ANON_MODEL}</code>, rate-limited per IP).
            Add a key from{' '}
            <a href="https://enter.pollinations.ai/keys" target="_blank" rel="noreferrer">enter.pollinations.ai</a>{' '}
            for more models.
          </p>
          <Field label="API key" hint="optional · stored only in this browser">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => patch({ apiKey: e.target.value })}
                placeholder="sk_… (leave empty for the anonymous tier)"
                spellCheck={false}
                autoComplete="off"
                style={{ flex: 1 }}
              />
              <button className="btn ghost sm" onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </Field>
          <Field label="Model" hint={`empty = ${defaultModel}`}>
            <input
              value={draft.model}
              onChange={(e) => patch({ model: e.target.value })}
              placeholder={defaultModel}
              list="pollinations-models"
              spellCheck={false}
            />
            <datalist id="pollinations-models">
              {models.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </datalist>
          </Field>
          {!keyed && (
            <Field label="Referrer" hint="optional app name sent to Pollinations">
              <input
                value={draft.referrer}
                onChange={(e) => patch({ referrer: e.target.value })}
                placeholder="teamz"
                spellCheck={false}
              />
            </Field>
          )}
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={draft.stream}
              onChange={(e) => patch({ stream: e.target.checked })}
              style={{ width: 'auto' }}
            />
            <span>Stream replies token by token</span>
          </label>
          <div className="test-row">
            <button className="btn ghost sm" onClick={runTest} disabled={testing}>
              <RefreshIcon size={14} /> {testing ? 'Testing…' : 'Test Pollinations'}
            </button>
            {test && <span className={`test-out${test.ok ? ' ok' : ' bad'}`}>{test.ok ? '✓' : '✕'} {test.text}</span>}
          </div>
        </>
      )}

      {draft.provider === 'custom' && (
        <p className="muted">Each agent calls the endpoint URL set in its own settings (request contract below).</p>
      )}
      {draft.provider === 'mock' && (
        <p className="muted">No network. Replies are canned persona text and are labelled as mock in the chat.</p>
      )}

      <div className="test-row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn primary sm" onClick={() => save(draft)} disabled={!dirty}>
          Save provider settings
        </button>
      </div>
    </div>
  );
}

interface WorkspaceInfoProps {
  open: boolean;
  onClose: () => void;
  onReset: () => void;
  agentCount: number;
  conversationCount: number;
}

/** Explains the mock/live switch and the request contract — where to plug in. */
export function WorkspaceInfo({ open, onClose, onReset, agentCount, conversationCount }: WorkspaceInfoProps) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [llm] = useLlmSettings();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Workspace & API"
      subtitle="How this front-end talks to your agents."
      width={600}
      footer={
        <>
          <div className="foot-left">
            {confirmReset ? (
              <div className="confirm-inline">
                <span>Reset all local data?</span>
                <button
                  className="btn danger sm"
                  onClick={() => {
                    onReset();
                    setConfirmReset(false);
                    onClose();
                  }}
                >
                  Yes, reset
                </button>
                <button className="btn ghost sm" onClick={() => setConfirmReset(false)}>Cancel</button>
              </div>
            ) : (
              <button className="btn ghost sm danger-hover" onClick={() => setConfirmReset(true)}>
                <RefreshIcon size={14} /> Reset to demo data
              </button>
            )}
          </div>
          <div className="foot-right">
            <button className="btn primary sm" onClick={onClose}>Done</button>
          </div>
        </>
      }
    >
      <div className="info-stats">
        <div>
          <strong>{agentCount}</strong>
          <span>agents</span>
        </div>
        <div>
          <strong>{conversationCount}</strong>
          <span>conversations</span>
        </div>
        <div>
          <strong className={llm.provider === 'mock' ? '' : 'live'}>{llm.provider}</strong>
          <span>provider</span>
        </div>
      </div>

      <ProviderSettings />

      <div className="info-block">
        <h3>Own endpoints</h3>
        <p>
          Pick <strong>Own endpoints</strong> above, then set each agent’s endpoint in its settings panel.
          The app will POST the request body below and read the reply.
        </p>
        <pre className="code-block">
{`POST {agent.endpointUrl}
Content-Type: application/json

{
  "agent":   { "id", "name", "model", "systemPrompt" },
  "messages":[{ "role": "user" | "assistant",
                "content": "...", "authorName": "Scout" }],
  "channel": { "id", "name", "members": [{ "id", "name" }] }
}`}
        </pre>
        <p className="muted">
          Response can be <code>{'{ "reply": "..." }'}</code>, <code>{'{ "text": "..." }'}</code>, or an
          OpenAI-style <code>choices[0].message.content</code>. Add your own shape in{' '}
          <code>parseReply()</code>.
        </p>
      </div>

      <div className="info-block">
        <h3>Where to change things</h3>
        <ul className="info-list">
          <li><code>src/api/agents.ts</code> — provider switch, own-endpoint request body + response parsing.</li>
          <li><code>src/api/pollinations.ts</code> — Pollinations request builder, streaming parser.</li>
          <li><code>src/store/useWorkspace.ts</code> — state, persistence, multi-agent fan-out.</li>
          <li><code>src/data/mock.ts</code> — seed agents, channels and demo messages.</li>
          <li><code>src/styles.css</code> — all design tokens at the top as CSS variables.</li>
        </ul>
      </div>
    </Modal>
  );
}
