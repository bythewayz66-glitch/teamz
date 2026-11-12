import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Seniority } from './types';
import { useWorkspace } from './store/useWorkspace';
import { useOrchestration } from './store/useOrchestration';
import { Automations } from './components/Automations';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { AgentSettings } from './components/AgentSettings';
import { NewAgentDialog } from './components/NewAgentDialog';
import { ChannelDialog } from './components/ChannelDialog';
import { WorkspaceInfo } from './components/WorkspaceInfo';
import { useLlmSettings } from './store/useLlmSettings';
import { hasKey, resolveModel } from './api/pollinations';
import { MenuIcon } from './components/Icons';

export default function App() {
  const ws = useWorkspace();
  const [llm] = useLlmSettings();
  const modeLabel =
    llm.provider === 'pollinations'
      ? `Pollinations · ${resolveModel(llm)}${hasKey(llm) ? '' : ' (free)'}`
      : llm.provider === 'custom'
        ? 'own endpoints'
        : 'mock mode';
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** Which surface the main column shows. */
  const [view, setView] = useState<'chat' | 'automations'>('chat');
  const orch = useOrchestration();

  const settingsAgent = settingsAgentId ? ws.agentsById.get(settingsAgentId) ?? null : null;

  /**
   * Fold real activity into the usage ledger.
   *
   * The first pass is skipped so the seeded history is not re-counted, and
   * every message id is remembered so a re-render never double-counts a turn.
   */
  const countedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const seen = countedRef.current;
    if (seen === null) {
      countedRef.current = new Set(
        Object.values(ws.state.messages)
          .flat()
          .map((m) => m.id),
      );
      return;
    }
    for (const list of Object.values(ws.state.messages)) {
      for (const m of list) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        if (m.authorType === 'agent' && m.authorId && m.status === 'sent' && m.text.trim()) {
          orch.recordRun(m.authorId, '', m.text);
        }
      }
    }
  }, [ws.state.messages, orch]);

  /** Send, and record the turn in the audit trail. */
  const handleSend = (text: string) => {
    const conv = ws.activeConversation;
    void ws.sendMessage(text);
    if (!conv) return;
    orch.logAudit({
      agentId: conv.agentIds[0],
      sessionId: conv.id,
      action: 'chat.send',
      decision: 'info',
      detail: `Message sent to ${conv.name}`,
    });
  };

  /** Newest message timestamp per conversation — drives sidebar ordering hints. */
  const lastMessageAt = useMemo(() => {
    const map: Record<string, number> = {};
    for (const [convId, list] of Object.entries(ws.state.messages)) {
      const last = list[list.length - 1];
      if (last) map[convId] = last.createdAt;
    }
    return map;
  }, [ws.state.messages]);

  const handleCreateAgent = (input: Omit<Agent, 'id' | 'createdAt' | 'status'>) => {
    // Hand-made agents are created and invited into the current room too.
    ws.createAgent(input);
    setSettingsAgentId(null);
  };

  const handleCreateFromTemplate = (
    templateId: string,
    name?: string,
    seniority?: Seniority,
  ) => {
    ws.createAgentFromTemplate(templateId, {
      name,
      seniority,
      conversationId: ws.state.activeConversationId,
      openDirect: false,
    });
  };

  return (
    <div className={`app-shell${sidebarOpen ? ' sidebar-open' : ''}`}>
      <div
        className="sidebar-scrim"
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />

      <Sidebar
        agents={ws.state.agents}
        conversations={ws.state.conversations}
        agentsById={ws.agentsById}
        activeConversationId={ws.state.activeConversationId}
        lastMessageAt={lastMessageAt}
        typing={ws.typing}
        onSelectConversation={(id) => {
          ws.setActiveConversation(id);
          setSidebarOpen(false);
        }}
        onNewAgent={() => setShowNewAgent(true)}
        onNewChannel={() => setShowNewChannel(true)}
        onOpenAgentSettings={(id) => setSettingsAgentId(id)}
        onOpenAgentChat={(id) => {
          ws.openDirectChat(id);
          setSidebarOpen(false);
        }}
        onOpenWorkspaceInfo={() => setShowInfo(true)}
        onOpenAutomations={() => {
          setView('automations');
          setSidebarOpen(false);
        }}
        automationsActive={view === 'automations'}
        approvalBadge={orch.pendingApprovals.length}
      />

      <div className="main-column">
        <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Show agents">
          <MenuIcon size={18} />
        </button>

        {view === 'automations' ? (
          <Automations
            agents={ws.state.agents}
            agentsById={ws.agentsById}
            triggers={orch.state.triggers}
            connections={orch.state.connections}
            policies={orch.state.policies}
            audit={orch.state.audit}
            approvals={orch.state.approvals}
            usage={orch.state.usage}
            widgets={orch.state.widgets}
            contextMessages={ws.activeMessages}
            onToggleTrigger={orch.toggleTrigger}
            onRunTrigger={orch.runTrigger}
            onDeleteTrigger={orch.deleteTrigger}
            onAddTrigger={orch.addTrigger}
            onConnect={orch.connect}
            onDisconnect={orch.disconnect}
            onSetDecision={orch.setDecision}
            onAddRule={orch.addRule}
            onRemoveRule={orch.removeRule}
            onDecideApproval={orch.decideApproval}
          />
        ) : (
        <ChatPane
          conversation={ws.activeConversation}
          messages={ws.activeMessages}
          agentsById={ws.agentsById}
          allAgents={ws.state.agents}
          typingAgentIds={ws.activeConversation ? ws.typing[ws.activeConversation.id] ?? [] : []}
          canReply={ws.canReply}
          filter={ws.activeFilter}
          onSetFilter={(filter) => {
            if (ws.activeConversation) ws.setConversationFilter(ws.activeConversation.id, filter);
          }}
          onSend={handleSend}
          onOpenAgentSettings={(id) => setSettingsAgentId(id)}
          onManageMembers={() => setShowMembers(true)}
          onDeleteConversation={() => {
            if (ws.activeConversation) ws.deleteConversation(ws.activeConversation.id);
          }}
          onOpenDirectChat={(id) => ws.openDirectChat(id)}
          onInviteAgent={(agentId) => {
            if (ws.activeConversation) {
              ws.inviteAgentToConversation(ws.activeConversation.id, agentId);
            }
          }}
          apiMode={llm.provider === 'mock' ? 'mock' : 'live'}
          modeLabel={modeLabel}
          onOpenSettings={() => setShowInfo(true)}
        />
        )}
      </div>

      <AgentSettings
        agent={settingsAgent}
        onClose={() => setSettingsAgentId(null)}
        onSave={ws.updateAgent}
        onDelete={(id) => {
          ws.deleteAgent(id);
          setSettingsAgentId(null);
        }}
        onOpenChat={(id) => ws.openDirectChat(id)}
      />

      <NewAgentDialog
        open={showNewAgent}
        onClose={() => setShowNewAgent(false)}
        onCreate={handleCreateAgent}
        onCreateFromTemplate={handleCreateFromTemplate}
        room={ws.activeConversation}
      />

      <ChannelDialog
        open={showNewChannel}
        onClose={() => setShowNewChannel(false)}
        agents={ws.state.agents}
        onCreate={ws.createChannel}
      />

      <ChannelDialog
        open={showMembers}
        onClose={() => setShowMembers(false)}
        agents={ws.state.agents}
        mode="members"
        editing={
          ws.activeConversation && ws.activeConversation.kind === 'channel'
            ? {
                id: ws.activeConversation.id,
                name: ws.activeConversation.name,
                topic: ws.activeConversation.topic,
                agentIds: ws.activeConversation.agentIds,
              }
            : null
        }
        onUpdateMembers={ws.updateChannelMembers}
        onRename={ws.renameConversation}
      />

      <WorkspaceInfo
        open={showInfo}
        onClose={() => setShowInfo(false)}
        onReset={ws.resetWorkspace}
        agentCount={ws.state.agents.length}
        conversationCount={ws.state.conversations.length}
      />
    </div>
  );
}
