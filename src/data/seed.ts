/**
 * ============================================================================
 *  Orchestration seed data
 * ============================================================================
 *
 *  A workspace that already looks lived-in: agents with sessions, connected
 *  accounts, policies, triggers, widgets, an audit trail and a usage ledger.
 *
 *  Everything is derived from a single `NOW` so the relative timestamps in the
 *  UI ("2 minutes ago", "yesterday") stay coherent no matter when the app is
 *  opened, and so the seed is deterministic enough to assert against in tests.
 */

import type {
  Approval,
  AuditEntry,
  Connection,
  Member,
  Notification,
  PolicyRule,
  Session,
  SkillDef,
  Trigger,
  TriggerRun,
  UsageEntry,
  Widget,
} from '../types';
import { defaultPolicy } from '../lib/policy';
import { dayKey } from '../lib/context';

const NOW = Date.now();
const mins = (n: number) => NOW - n * 60 * 1000;
const hours = (n: number) => NOW - n * 60 * 60 * 1000;
const days = (n: number) => NOW - n * 24 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ members */

export const seedMembers: Member[] = [
  {
    id: 'member-you',
    name: 'You',
    email: 'you@teamz.local',
    role: 'owner',
    isYou: true,
    joinedAt: days(120),
    initials: 'YO',
  },
  {
    id: 'member-dana',
    name: 'Dana Whitfield',
    email: 'dana@teamz.local',
    role: 'editor',
    joinedAt: days(64),
    initials: 'DW',
  },
  {
    id: 'member-sam',
    name: 'Sam Rivera',
    email: 'sam@teamz.local',
    role: 'editor',
    joinedAt: days(41),
    initials: 'SR',
  },
  {
    id: 'member-priya',
    name: 'Priya Shah',
    email: 'priya@teamz.local',
    role: 'viewer',
    joinedAt: days(12),
    initials: 'PS',
  },
];

/* ----------------------------------------------------------------- sessions */

export const seedSessions: Session[] = [
  { id: 'sess-scout-1', agentId: 'agent-scout', title: 'Weekly pipeline brief', createdAt: hours(30), updatedAt: mins(2), pinned: true },
  { id: 'sess-scout-2', agentId: 'agent-scout', title: 'Score this week’s inbound', createdAt: days(1), updatedAt: days(1) },
  { id: 'sess-scout-3', agentId: 'agent-scout', title: 'Q4 target accounts', createdAt: days(2), updatedAt: days(2) },
  { id: 'sess-scout-4', agentId: 'agent-scout', title: 'Enrich the Northwind list', createdAt: days(3), updatedAt: days(3) },
  { id: 'sess-atlas-1', agentId: 'agent-atlas', title: 'Streaming transport review', createdAt: hours(20), updatedAt: hours(19) },
  { id: 'sess-atlas-2', agentId: 'agent-atlas', title: 'Retry + timeout policy', createdAt: days(2), updatedAt: days(2) },
  { id: 'sess-pixel-1', agentId: 'agent-pixel', title: 'Dark palette contrast pass', createdAt: hours(8), updatedAt: hours(7) },
  { id: 'sess-sage-1', agentId: 'agent-sage', title: 'README rewrite', createdAt: days(4), updatedAt: days(4) },
];

/* -------------------------------------------------------------- connections */

export const seedConnections: Connection[] = [
  {
    id: 'conn-gmail',
    service: 'gmail',
    account: 'you@teamz.local',
    scopes: ['gmail.readonly', 'gmail.compose', 'gmail.send'],
    connectedAt: days(30),
    lastUsedAt: mins(60),
    status: 'connected',
  },
  {
    id: 'conn-slack',
    service: 'slack',
    account: '#build-room',
    scopes: ['channels:read', 'chat:write'],
    connectedAt: days(28),
    lastUsedAt: mins(1),
    status: 'connected',
  },
  {
    id: 'conn-sheets',
    service: 'googlesheets',
    account: 'Sell-through tracker',
    scopes: ['spreadsheets.readonly', 'spreadsheets'],
    connectedAt: days(21),
    lastUsedAt: mins(4),
    status: 'connected',
  },
  {
    id: 'conn-shopify',
    service: 'shopify',
    account: 'alderandoak.myshopify.com',
    scopes: ['read_products', 'read_orders', 'write_inventory'],
    connectedAt: days(18),
    lastUsedAt: hours(3),
    status: 'connected',
  },
  {
    id: 'conn-github',
    service: 'github',
    account: 'bythewayz66-glitch',
    scopes: ['repo:read', 'issues:write'],
    connectedAt: days(9),
    lastUsedAt: hours(6),
    status: 'connected',
  },
  {
    id: 'conn-apollo',
    service: 'apollo',
    account: 'you@teamz.local',
    scopes: ['contacts:read'],
    connectedAt: days(40),
    lastUsedAt: days(3),
    status: 'error',
    error: 'API key expired — reconnect to resume contact lookups.',
  },
];

/* ----------------------------------------------------------------- policies */

/**
 * Per-agent policy. Agents that touch outbound systems get the conservative
 * default plus a couple of explicit rules; the rest inherit the default.
 */
export const seedPolicies: Record<string, PolicyRule[]> = {
  'agent-scout': [
    ...defaultPolicy(),
    { id: 'pol-scout-1', service: 'apollo', action: 'contacts.search', decision: 'allow', note: 'Sourcing is read-only.' },
    { id: 'pol-scout-2', service: 'apollo', action: 'contacts.delete', decision: 'block', note: 'Never delete contacts.' },
    { id: 'pol-scout-3', service: 'gmail', action: 'send', decision: 'review', note: 'Outbound mail always needs a human.' },
  ],
  'agent-atlas': [
    ...defaultPolicy(),
    { id: 'pol-atlas-1', service: 'github', action: 'code.search', decision: 'allow', note: 'Code search is read-only.' },
    { id: 'pol-atlas-2', service: 'github', action: 'pulls.create', decision: 'review', note: 'PRs need review before they open.' },
    { id: 'pol-atlas-3', service: 'github', action: 'branches.delete', decision: 'block', note: 'Never delete a branch.' },
  ],
  'agent-pixel': defaultPolicy(),
  'agent-sage': defaultPolicy(),
};

/* ----------------------------------------------------------------- triggers */

export const seedTriggers: Trigger[] = [
  {
    id: 'trig-scout-morning',
    agentId: 'agent-scout',
    name: 'Morning lead sweep',
    kind: 'cron',
    cron: '0 8 * * 1-5',
    prompt: 'Sweep the inbound list, score each lead, and post the top five to #build-room.',
    enabled: true,
    createdAt: days(20),
    lastFiredAt: hours(9),
    fireCount: 14,
  },
  {
    id: 'trig-scout-webhook',
    agentId: 'agent-scout',
    name: 'New inbound lead',
    kind: 'webhook',
    token: 'whk_7f3a91c2',
    prompt: 'A new lead just arrived. Enrich it, score it, and tell me if it is worth a call today.',
    enabled: true,
    createdAt: days(14),
    lastFiredAt: mins(35),
    fireCount: 14,
  },
  {
    id: 'trig-atlas-nightly',
    agentId: 'agent-atlas',
    name: 'Nightly dependency audit',
    kind: 'cron',
    cron: '0 2 * * *',
    prompt: 'Check the dependency tree for advisories and open an issue for anything critical.',
    enabled: true,
    createdAt: days(11),
    lastFiredAt: hours(15),
    fireCount: 11,
  },
  {
    id: 'trig-sage-weekly',
    agentId: 'agent-sage',
    name: 'Weekly changelog draft',
    kind: 'cron',
    cron: '0 16 * * 5',
    prompt: 'Draft the changelog from this week’s merged pull requests.',
    enabled: false,
    createdAt: days(7),
    fireCount: 0,
  },
];

export const seedTriggerRuns: TriggerRun[] = [
  { id: 'run-1', triggerId: 'trig-scout-morning', agentId: 'agent-scout', at: hours(9), status: 'ok', summary: '18 leads scored · 5 posted to #build-room' },
  { id: 'run-2', triggerId: 'trig-scout-webhook', agentId: 'agent-scout', at: mins(35), status: 'ok', summary: 'Northwind Labs enriched · score 82' },
  { id: 'run-3', triggerId: 'trig-atlas-nightly', agentId: 'agent-atlas', at: hours(15), status: 'ok', summary: '412 packages checked · 0 critical' },
  { id: 'run-4', triggerId: 'trig-scout-morning', agentId: 'agent-scout', at: hours(33), status: 'error', summary: 'Apollo key expired — enrichment skipped' },
  { id: 'run-5', triggerId: 'trig-atlas-nightly', agentId: 'agent-atlas', at: hours(39), status: 'ok', summary: '412 packages checked · 1 moderate' },
];

/* ---------------------------------------------------------------- approvals */

export const seedApprovals: Approval[] = [
  {
    id: 'appr-1',
    agentId: 'agent-scout',
    sessionId: 'sess-scout-1',
    action: {
      service: 'gmail',
      action: 'send',
      args: { to: ['northwind@example.com', 'kestrel@example.com'], subject: 'Following up on your enquiry' },
      summary: 'Send 2 follow-up emails with Gmail',
    },
    verdict: { decision: 'review', ruleId: 'pol-scout-3', reason: 'Outbound mail always needs a human.' },
    createdAt: mins(6),
    status: 'pending',
  },
  {
    id: 'appr-2',
    agentId: 'agent-atlas',
    sessionId: 'sess-atlas-1',
    action: {
      service: 'github',
      action: 'pulls.create',
      args: { repo: 'bythewayz66-glitch/teamz', title: 'fix: window history per channel member' },
      summary: 'Open a pull request on teamz',
    },
    verdict: { decision: 'review', ruleId: 'pol-atlas-2', reason: 'PRs need review before they open.' },
    createdAt: mins(22),
    status: 'pending',
  },
  {
    id: 'appr-3',
    agentId: 'agent-scout',
    sessionId: 'sess-scout-2',
    action: {
      service: 'apollo',
      action: 'contacts.delete',
      args: { ids: ['apollo-8812'] },
      summary: 'Delete 1 contact from Apollo',
    },
    verdict: { decision: 'block', ruleId: 'pol-scout-2', reason: 'Never delete contacts.' },
    createdAt: hours(2),
    status: 'denied',
    decidedAt: hours(2),
    decidedBy: 'you',
  },
];

/* -------------------------------------------------------------- audit trail */

export const seedAudit: AuditEntry[] = [
  { id: 'aud-1', at: mins(1), agentId: 'agent-scout', action: 'slack.messages.post', decision: 'allow', detail: 'Posted the morning brief to #build-room', ruleId: 'pol-read', executed: true },
  { id: 'aud-2', at: mins(4), agentId: 'agent-scout', action: 'googlesheets.values.get', decision: 'allow', detail: 'Read 412 rows from Sell-through tracker', ruleId: 'pol-get', executed: true },
  { id: 'aud-3', at: mins(6), agentId: 'agent-scout', action: 'gmail.send', decision: 'review', detail: '2 follow-up emails queued for approval', ruleId: 'pol-scout-3' },
  { id: 'aud-4', at: mins(22), agentId: 'agent-atlas', action: 'github.pulls.create', decision: 'review', detail: 'Pull request queued for approval', ruleId: 'pol-atlas-2' },
  { id: 'aud-5', at: mins(35), agentId: 'agent-scout', action: 'apollo.contacts.search', decision: 'allow', detail: 'Searched 1 contact for Northwind Labs', ruleId: 'pol-scout-1', executed: true },
  { id: 'aud-6', at: hours(2), agentId: 'agent-scout', action: 'apollo.contacts.delete', decision: 'block', detail: 'Deletion of 1 contact refused', ruleId: 'pol-scout-2' },
  { id: 'aud-7', at: hours(2), agentId: 'agent-scout', action: 'fs.read', decision: 'block', detail: 'Attempted to read ~/Documents — outside the sandbox', ruleId: 'pol-fs' },
  { id: 'aud-8', at: hours(3), agentId: 'agent-scout', action: 'shopify.inventory.levels', decision: 'allow', detail: 'Read stock levels for 412 SKUs', ruleId: 'pol-read', executed: true },
  { id: 'aud-9', at: hours(9), agentId: 'agent-scout', action: 'trigger.fire', decision: 'info', detail: 'Morning lead sweep ran on schedule' },
  { id: 'aud-10', at: hours(15), agentId: 'agent-atlas', action: 'trigger.fire', decision: 'info', detail: 'Nightly dependency audit ran on schedule' },
  { id: 'aud-11', at: hours(20), agentId: 'agent-atlas', action: 'github.code.search', decision: 'allow', detail: 'Searched 3 repositories for stream readers', ruleId: 'pol-atlas-1', executed: true },
  { id: 'aud-12', at: days(1), agentId: 'agent-sage', action: 'fs.write', decision: 'review', detail: 'Draft written to the sandbox volume', ruleId: 'pol-write2' },
];

/* ------------------------------------------------------------------ widgets */

export const seedWidgets: Widget[] = [
  {
    id: 'wid-pipeline',
    agentId: 'agent-scout',
    title: 'Pipeline',
    kind: 'metric',
    caption: 'Q4 · live',
    updatedAt: mins(2),
    metrics: [
      { label: 'Won this month', value: '$1.24M', delta: '+12%', tone: 'good' },
      { label: 'Open pipeline', value: '$310k', tone: 'warn' },
      { label: 'Win rate', value: '32%', tone: 'good' },
      { label: 'Avg deal', value: '$38k' },
    ],
  },
  {
    id: 'wid-stages',
    agentId: 'agent-scout',
    title: 'Deals by stage',
    kind: 'bars',
    caption: '19 deals · $420k',
    updatedAt: mins(2),
    bars: [
      { label: 'Lead', value: 8, caption: '8 deals' },
      { label: 'Qualified', value: 5, caption: '5 deals' },
      { label: 'Proposal', value: 4, caption: '4 deals' },
      { label: 'Negotiation', value: 2, caption: '2 deals', tone: 'warn' },
    ],
  },
  {
    id: 'wid-followup',
    agentId: 'agent-scout',
    title: 'Needs follow-up',
    kind: 'list',
    caption: 'No reply in 6+ days',
    updatedAt: mins(2),
    rows: [
      { cells: ['Northwind Labs', '$24k', 'No reply in 6 days'], tone: 'warn' },
      { cells: ['Kestrel Co', '$12k', 'Proposal sent Friday'], tone: 'warn' },
      { cells: ['Alder & Finch', '$9k', 'Replied yesterday'], tone: 'good' },
    ],
  },
  {
    id: 'wid-stock',
    agentId: 'agent-scout',
    title: 'Stock cover',
    kind: 'bars',
    caption: '412 SKUs · forecast updated 7:02 AM',
    updatedAt: hours(9),
    bars: [
      { label: 'Linen Throw', value: 9, caption: '9d · Oct 14', tone: 'bad' },
      { label: 'Oak Serving Board', value: 12, caption: '12d · Oct 17', tone: 'bad' },
      { label: 'Stoneware Mug Set', value: 14, caption: '14d · Oct 19', tone: 'warn' },
      { label: 'Wool Blanket', value: 41, caption: '41d · Nov 15', tone: 'good' },
      { label: 'Ceramic Vase', value: 58, caption: '58d · Dec 2', tone: 'good' },
    ],
  },
  {
    id: 'wid-po',
    agentId: 'agent-scout',
    title: 'Purchase orders',
    kind: 'table',
    caption: '3 drafted · awaiting approval',
    updatedAt: hours(9),
    columns: ['PO', 'Supplier', 'Units', 'Lands', 'Status'],
    rows: [
      { cells: ['PO-1042', 'Linen & Co', '600', 'Nov 10', 'Draft'], tone: 'warn' },
      { cells: ['PO-1043', 'Oakline Supply', '450', 'Nov 11', 'Draft'], tone: 'warn' },
      { cells: ['PO-1044', 'Shenzhen Ceramics', '1,200', 'Nov 12', 'Draft'], tone: 'warn' },
    ],
  },
  {
    id: 'wid-build',
    agentId: 'agent-atlas',
    title: 'Build health',
    kind: 'metric',
    caption: 'main · last 7 days',
    updatedAt: hours(1),
    metrics: [
      { label: 'Typecheck', value: 'pass', tone: 'good' },
      { label: 'Tests', value: '88', tone: 'good' },
      { label: 'Open PRs', value: '2', tone: 'warn' },
      { label: 'Advisories', value: '0', tone: 'good' },
    ],
  },
  {
    id: 'wid-coverage',
    agentId: 'agent-atlas',
    title: 'Test coverage',
    kind: 'progress',
    caption: 'statements',
    updatedAt: hours(1),
    progress: 0.78,
  },
  {
    id: 'wid-contrast',
    agentId: 'agent-pixel',
    title: 'Contrast audit',
    kind: 'table',
    caption: 'dark palette · WCAG AA',
    updatedAt: hours(7),
    columns: ['Token', 'Ratio', 'Verdict'],
    rows: [
      { cells: ['--text on --bg-app', '14.2:1', 'Pass'], tone: 'good' },
      { cells: ['--text-dim on --bg-panel', '7.1:1', 'Pass'], tone: 'good' },
      { cells: ['--text-mute on --bg-rail', '4.4:1', 'Borderline'], tone: 'warn' },
      { cells: ['--text-mute on --bg-hover', '3.9:1', 'Fail'], tone: 'bad' },
    ],
  },
];

/* ------------------------------------------------------------ notifications */

export const seedNotifications: Notification[] = [
  { id: 'notif-1', at: mins(6), kind: 'approval', title: 'Scout needs approval', body: 'Send 2 follow-up emails with Gmail', read: false, agentId: 'agent-scout', sessionId: 'sess-scout-1' },
  { id: 'notif-2', at: mins(22), kind: 'approval', title: 'Atlas needs approval', body: 'Open a pull request on teamz', read: false, agentId: 'agent-atlas', sessionId: 'sess-atlas-1' },
  { id: 'notif-3', at: mins(35), kind: 'trigger', title: 'New inbound lead fired', body: 'Northwind Labs enriched · score 82', read: false, agentId: 'agent-scout' },
  { id: 'notif-4', at: hours(2), kind: 'error', title: 'Apollo connection expired', body: 'Reconnect to resume contact lookups', read: true },
  { id: 'notif-5', at: hours(9), kind: 'trigger', title: 'Morning lead sweep ran', body: '18 leads scored · 5 posted to #build-room', read: true, agentId: 'agent-scout' },
];

/* -------------------------------------------------------------- usage ledger */

function ledgerRow(dayOffset: number, agentId: string, prompt: number, completion: number, runs: number): UsageEntry {
  return { day: dayKey(days(dayOffset)), agentId, promptTokens: prompt, completionTokens: completion, runs };
}

export const seedUsage: UsageEntry[] = [
  ledgerRow(0, 'agent-scout', 18_400, 6_200, 9),
  ledgerRow(0, 'agent-atlas', 9_100, 3_400, 4),
  ledgerRow(0, 'agent-pixel', 2_200, 900, 2),
  ledgerRow(1, 'agent-scout', 22_800, 7_100, 11),
  ledgerRow(1, 'agent-atlas', 11_400, 4_100, 5),
  ledgerRow(1, 'agent-sage', 1_800, 700, 1),
  ledgerRow(2, 'agent-scout', 15_200, 5_400, 7),
  ledgerRow(2, 'agent-atlas', 8_600, 3_100, 4),
  ledgerRow(3, 'agent-scout', 12_900, 4_800, 6),
  ledgerRow(3, 'agent-pixel', 3_100, 1_200, 3),
  ledgerRow(4, 'agent-scout', 9_400, 3_600, 5),
  ledgerRow(4, 'agent-atlas', 6_200, 2_400, 3),
  ledgerRow(5, 'agent-scout', 7_100, 2_800, 4),
  ledgerRow(5, 'agent-sage', 2_400, 900, 2),
  ledgerRow(6, 'agent-scout', 5_600, 2_100, 3),
  ledgerRow(6, 'agent-atlas', 4_100, 1_600, 2),
];

/* ------------------------------------------------------------------- skills */

/**
 * Skills an agent has been given, with usage. Seeded for the two agents that
 * have a history; the rest start empty and gain skills as they are used.
 */
export const seedSkills: Record<string, SkillDef[]> = {
  'agent-scout': [
    { id: 'sk-1', key: 'lead-scoring', name: 'Lead scoring', description: 'Score a lead on fit × warmth and explain the number.', source: 'template', addedAt: days(20), lastUsedAt: mins(35), uses: 14 },
    { id: 'sk-2', key: 'pipeline-review', name: 'Pipeline review', description: 'Summarise pipeline by stage and flag deals that stalled.', source: 'template', addedAt: days(18), lastUsedAt: hours(3), uses: 9 },
    { id: 'sk-3', key: 'forecast-stockouts', name: 'Forecast stockouts', description: 'Project days of cover from sales velocity and lead times.', source: 'custom', addedAt: hours(9), lastUsedAt: hours(9), uses: 2 },
  ],
  'agent-atlas': [
    { id: 'sk-4', key: 'diff-review', name: 'Diff review', description: 'Review a diff for correctness, then for readability.', source: 'template', addedAt: days(11), lastUsedAt: hours(20), uses: 6 },
    { id: 'sk-5', key: 'dependency-audit', name: 'Dependency audit', description: 'Check the dependency tree for advisories and rank by severity.', source: 'custom', addedAt: days(11), lastUsedAt: hours(15), uses: 11 },
  ],
  'agent-pixel': [
    { id: 'sk-6', key: 'contrast-audit', name: 'Contrast audit', description: 'Measure every text/background pair against WCAG AA.', source: 'custom', addedAt: hours(8), lastUsedAt: hours(7), uses: 1 },
  ],
  'agent-sage': [],
};
