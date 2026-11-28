import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Seniority } from './types';
import { useWorkspace } from './store/useWorkspace';
import { useAutonomy } from './store/useAutonomy';
import { Sidebar } from './components/Sidebar';
import { ChatPane } from './components/ChatPane';
import { JobsPanel } from './components/JobsPanel';
import { AgentSettings } from './components/AgentSettings';
import { NewAgentDialog } from './components/NewAgentDialog';
import { ChannelDialog } from './components/ChannelDialog';
import { WorkspaceInfo } from './components/WorkspaceInfo';
import { useLlmSettings } from './store/useLlmSettings';
import { hasKey, resolveModel } from './api/pollinations';
import { MenuIcon, SearchIcon } from './components/Icons';
import { CommandPalette } from './components/CommandPalette';
import { AgentHome } from './components/AgentHome';
import { SessionBar } from './components/SessionBar';
import { useOperations } from './store/useOperations';
import { buildAgentHome } from './lib/agentHome';
import type { SearchAction } from './lib/search';

export default function App() {
  const ws = useWorkspace();
  const autonomy = useAutonomy(ws);
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
  const [showJobs, setShowJobs] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  /** When set, the main column shows this agent's home instead of a conversation. */
  const [homeAgentId, setHomeAgentId] = useState<string | null>(null);
  const ops = useOperations();
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  /* Mobile drawer: Esc closes it, and focus returns to the hamburger when it
     closes while focus was inside the drawer. */
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  useEffect(() => {
    if (sidebarOpen) return;
    const sidebar = document.getElementById('teamz-sidebar');
    if (sidebar && sidebar.contains(document.activeElement)) {
      menuBtnRef.current?.focus();
    }
  }, [sidebarOpen]);

  /* Ctrl/Cmd+K opens the palette from anywhere. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /* Re-render once a minute so "30 minutes ago" and "in 12 minutes" stay true. */
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const homeAgent = homeAgentId ? ws.agentsById.get(homeAgentId) ?? null : null;
  const homeModel = useMemo(
    () =>
      homeAgent
        ? buildAgentHome({
            agent: homeAgent,
            state: ws.state,
            runner: ops.runner,
            local: { jobs: autonomy.jobs, triggers: autonomy.triggers, cronJobs: autonomy.cronJobs },
            ledger: ops.ledger,
            rate: ops.rate,
            now: clock,
          })
        : null,
    [homeAgent, ws.state, ops.runner, ops.ledger, ops.rate, autonomy.jobs, autonomy.triggers, autonomy.cronJobs, clock],
  );

  /* Any navigation that changes the active conversation leaves the agent home. */
  useEffect(() => setHomeAgentId(null), [ws.state.activeConversationId]);

  const openSession = (id: string) => {
    ws.openSession(id);
    setHomeAgentId(null);
    setSidebarOpen(false);
  };
  const openHome = (agentId: string) => {
    setHomeAgentId(agentId);
    setSidebarOpen(false);
  };

  const onSearchAction = (a: SearchAction) => {
    if (a.type === 'open-agent') openHome(a.agentId);
    else if (a.type === 'open-session') openSession(a.conversationId);
    else if (a.target === 'jobs') setShowJobs(true);
    else if (a.target === 'new-agent') setShowNewAgent(true);
    else if (a.target === 'new-channel') setShowNewChannel(true);
    else setShowInfo(true);
  };

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
      <button
        type="button"
        className="sidebar-scrim"
        onClick={() => setSidebarOpen(false)}
        aria-label="Close navigation menu"
        tabIndex={-1}
      />

      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        agents={ws.state.agents}
        conversations={ws.state.conversations}
        agentsById={ws.agentsById}
        activeConversationId={ws.state.activeConversationId}
        lastMessageAt={lastMessageAt}
        typing={ws.typing}
        onSelectConversation={(id) => openSession(id)}
        onNewAgent={() => setShowNewAgent(true)}
        onNewChannel={() => setShowNewChannel(true)}
        onOpenAgentSettings={(id) => setSettingsAgentId(id)}
        onOpenAgentChat={(id) => {
          ws.openDirectChat(id);
          setHomeAgentId(null);
          setSidebarOpen(false);
        }}
        onOpenAgentHome={openHome}
        onOpenWorkspaceInfo={() => setShowInfo(true)}
      />

      <div className="main-column">
        <button
          ref={menuBtnRef}
          className="mobile-menu"
          onClick={() => setSidebarOpen(true)}
          aria-label="Show agents"
          aria-expanded={sidebarOpen}
          aria-controls="teamz-sidebar"
        >
          <MenuIcon size={18} />
        </button>

        {/* Autonomy nav (additive): opens the Jobs & Scheduler panel. */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px 0' }}>
          <button className="btn ghost sm search-trigger" onClick={() => setShowPalette(true)} aria-label="Search agents, sessions and settings">
            <SearchIcon size={13} /> Search <kbd>Ctrl K</kbd>
          </button>
          <button className="btn ghost sm" onClick={() => setShowJobs(true)}>
            Jobs &amp; Scheduler
            {autonomy.pendingApprovalCount > 0
              ? ` (${autonomy.pendingApprovalCount} approval${autonomy.pendingApprovalCount === 1 ? '' : 's'} waiting)`
              : ''}
          </button>
        </div>

        {homeModel ? (
          <AgentHome
            home={homeModel}
            now={clock}
            runnerStale={ops.stale}
            runnerFetchedAt={ops.runner?.fetchedAt ?? null}
            onOpenSession={openSession}
            onNewSession={() => {
              ws.newSession(homeModel.agent.id);
              setHomeAgentId(null);
            }}
            onResume={(id) => {
              openSession(id);
              void ws.resumeSession(id);
            }}
            onOpenSettings={() => setSettingsAgentId(homeModel.agent.id)}
            onOpenCostRate={() => setShowInfo(true)}
          />
        ) : (
          <>
        {ws.activeConversation?.session && (
          <SessionBar
            conversation={ws.activeConversation}
            agentName={
              ws.activeConversation.session.agentId
                ? ws.agentsById.get(ws.activeConversation.session.agentId)?.name
                : undefined
            }
            onRename={(name) => ws.renameSession(ws.activeConversation!.id, name)}
            onRetention={(p) => ws.setSessionRetention(ws.activeConversation!.id, p)}
            onArchive={(a) => ws.archiveSession(ws.activeConversation!.id, a)}
            onResume={() => void ws.resumeSession(ws.activeConversation!.id)}
            onOpenHome={
              ws.activeConversation.session.agentId
                ? () => openHome(ws.activeConversation!.session!.agentId!)
                : undefined
            }
          />
        )}
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
          onOpenDirectChat={(id) => {
            ws.openDirectChat(id);
            setHomeAgentId(null);
          }}
          onInviteAgent={(agentId) => {
            if (ws.activeConversation) {
              ws.inviteAgentToConversation(ws.activeConversation.id, agentId);
            }
          }}
          apiMode={llm.provider === 'mock' ? 'mock' : 'live'}
          modeLabel={modeLabel}
          onOpenSettings={() => setShowInfo(true)}
        />
          </>
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
        onOpenChat={(id) => {
          ws.openDirectChat(id);
          setHomeAgentId(null);
        }}
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
        rate={ops.rate}
        onSetRate={ops.setRate}
      />

      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        state={ws.state}
        onAction={onSearchAction}
      />

      <JobsPanel
        open={showJobs}
        onClose={() => setShowJobs(false)}
        autonomy={autonomy}
        agents={ws.state.agents}
        conversations={ws.state.conversations}
        onOpenConversation={(id) => openSession(id)}
      />
    </div>
  );
}
