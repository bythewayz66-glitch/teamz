import { useState } from 'react';
import { Modal } from './Modal';
import { API_MODE } from '../api/agents';
import { RefreshIcon } from './Icons';

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
          <strong className={API_MODE === 'live' ? 'live' : ''}>{API_MODE}</strong>
          <span>API mode</span>
        </div>
      </div>

      <div className="info-block">
        <h3>Mock mode (default)</h3>
        <p>
          Nothing leaves the browser. Messages are stored in <code>localStorage</code> and replies come
          from canned persona responses in <code>src/api/agents.ts</code>. Everything is clickable — perfect
          for designing against.
        </p>
      </div>

      <div className="info-block">
        <h3>Live mode</h3>
        <p>
          Create a <code>.env.local</code> with <code>VITE_API_MODE=live</code>, then set each agent’s
          endpoint in its settings panel. The app will POST the request body below and read the reply.
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
          <li><code>src/api/agents.ts</code> — the only network code. Request body + response parsing.</li>
          <li><code>src/store/useWorkspace.ts</code> — state, persistence, multi-agent fan-out.</li>
          <li><code>src/data/mock.ts</code> — seed agents, channels and demo messages.</li>
          <li><code>src/styles.css</code> — all design tokens at the top as CSS variables.</li>
        </ul>
      </div>
    </Modal>
  );
}
