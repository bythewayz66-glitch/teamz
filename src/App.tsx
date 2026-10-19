import { useMemo, useState } from 'react';
import type { Agent, Seniority } from './types';
import { useWorkspace } from './store/useWorkspace';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { AgentSettings } from './components/AgentSettings';
import { NewAgentDialog } from './components/NewAgentDialog';
import { ChannelDialog } from './components/ChannelDialog';
import { WorkspaceInfo } from './components/WorkspaceInfo';
import { API_MODE } from './api/agents';
import { MenuIcon } from './components/Icons';

export default function App() {
  const ws = useWorkspace();
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const settingsAgent = settingsAgentId ? ws.agentsById.get(settingsAgentId) ?? null : null;

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
      />

      <div className="main-column">
        <button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="Show agents">
          <MenuIcon size={18} />
        </button>

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
          onSend={ws.sendMessage}
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
          apiMode={API_MODE}
        />
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
