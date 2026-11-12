/**
 * ============================================================================
 *  Connector catalogue
 * ============================================================================
 *
 *  The services an agent can be connected to, and the actions each one
 *  exposes. This is the vocabulary the policy engine speaks: a rule is
 *  `service` + `action`, and both must come from here so the policy editor can
 *  offer real choices instead of free text.
 *
 *  `actions` are the *tool calls* an agent may propose. They are grouped by
 *  risk so the default policy can be generated rather than hand-written:
 *
 *    read        — list/get/read; safe, allowed by default
 *    write       — create/update/send; needs review by default
 *    destructive — delete/archive; blocked by default
 *
 *  Nothing here performs a network call. The catalogue is data; the transport
 *  lives in `api/agents.ts` and the decision in `lib/policy.ts`.
 */

export type ActionRisk = 'read' | 'write' | 'destructive';

export interface ConnectorAction {
  /** Dotted action name, e.g. `orders.list`. */
  action: string;
  label: string;
  risk: ActionRisk;
}

export interface Connector {
  /** Slug used in policy rules and connection records. */
  slug: string;
  name: string;
  /** Emoji stand-in for the service logo (no external assets). */
  glyph: string;
  /** Brand-ish accent used for the tile. */
  accent: string;
  /** One line describing what connecting it lets an agent do. */
  blurb: string;
  /** OAuth scopes the user grants. Shown before connecting. */
  scopes: string[];
  actions: ConnectorAction[];
}

const read = (action: string, label: string): ConnectorAction => ({ action, label, risk: 'read' });
const write = (action: string, label: string): ConnectorAction => ({ action, label, risk: 'write' });
const destroy = (action: string, label: string): ConnectorAction => ({
  action,
  label,
  risk: 'destructive',
});

export const CONNECTORS: Connector[] = [
  {
    slug: 'gmail',
    name: 'Gmail',
    glyph: '✉️',
    accent: '#ea4335',
    blurb: 'Read the inbox, draft replies and send mail on your behalf.',
    scopes: ['gmail.readonly', 'gmail.compose', 'gmail.send'],
    actions: [
      read('messages.list', 'List messages'),
      read('messages.get', 'Read a message'),
      write('drafts.create', 'Create a draft'),
      write('send', 'Send an email'),
      destroy('messages.delete', 'Delete a message'),
    ],
  },
  {
    slug: 'slack',
    name: 'Slack',
    glyph: '💬',
    accent: '#611f69',
    blurb: 'Post into channels and read the threads your team is working in.',
    scopes: ['channels:read', 'chat:write', 'users:read'],
    actions: [
      read('channels.list', 'List channels'),
      read('messages.list', 'Read a channel'),
      write('messages.post', 'Post a message'),
      destroy('messages.delete', 'Delete a message'),
    ],
  },
  {
    slug: 'googlesheets',
    name: 'Google Sheets',
    glyph: '📊',
    accent: '#0f9d58',
    blurb: 'Read and write the spreadsheets your team keeps its numbers in.',
    scopes: ['spreadsheets.readonly', 'spreadsheets'],
    actions: [
      read('values.get', 'Read a range'),
      write('values.append', 'Append rows'),
      write('values.update', 'Update cells'),
      destroy('sheets.delete', 'Delete a sheet'),
    ],
  },
  {
    slug: 'shopify',
    name: 'Shopify',
    glyph: '🛍️',
    accent: '#95bf47',
    blurb: 'Watch inventory and orders, and draft purchase orders.',
    scopes: ['read_products', 'read_orders', 'write_inventory'],
    actions: [
      read('orders.list', 'List orders'),
      read('products.list', 'List products'),
      read('inventory.levels', 'Read stock levels'),
      write('inventory.update', 'Adjust stock'),
      write('draft_orders.create', 'Draft an order'),
      destroy('products.delete', 'Delete a product'),
    ],
  },
  {
    slug: 'stripe',
    name: 'Stripe',
    glyph: '💳',
    accent: '#635bff',
    blurb: 'Pull revenue and invoices, and reconcile them against your books.',
    scopes: ['charges:read', 'invoices:read', 'balance:read'],
    actions: [
      read('charges.list', 'List charges'),
      read('invoices.list', 'List invoices'),
      read('balance.get', 'Read balance'),
      write('invoices.send', 'Send an invoice'),
      destroy('customers.delete', 'Delete a customer'),
    ],
  },
  {
    slug: 'github',
    name: 'GitHub',
    glyph: '🐙',
    accent: '#8b949e',
    blurb: 'Search code and issues, and open pull requests.',
    scopes: ['repo:read', 'issues:write', 'pull_requests:write'],
    actions: [
      read('repos.list', 'List repositories'),
      read('issues.list', 'List issues'),
      read('code.search', 'Search code'),
      write('issues.create', 'Open an issue'),
      write('pulls.create', 'Open a pull request'),
      destroy('branches.delete', 'Delete a branch'),
    ],
  },
  {
    slug: 'notion',
    name: 'Notion',
    glyph: '📓',
    accent: '#a8a8a8',
    blurb: 'Read and write the pages your team documents decisions in.',
    scopes: ['read_content', 'insert_content', 'update_content'],
    actions: [
      read('pages.search', 'Search pages'),
      read('pages.get', 'Read a page'),
      write('pages.create', 'Create a page'),
      write('pages.update', 'Update a page'),
      destroy('pages.archive', 'Archive a page'),
    ],
  },
  {
    slug: 'salesforce',
    name: 'Salesforce',
    glyph: '☁️',
    accent: '#00a1e0',
    blurb: 'Query pipeline and update forecast fields for approval.',
    scopes: ['api', 'refresh_token'],
    actions: [
      read('accounts.list', 'List accounts'),
      read('opportunities.list', 'List opportunities'),
      write('opportunities.update', 'Update an opportunity'),
      write('notes.create', 'Log a note'),
      destroy('records.delete', 'Delete a record'),
    ],
  },
  {
    slug: 'googlecalendar',
    name: 'Google Calendar',
    glyph: '📅',
    accent: '#4285f4',
    blurb: 'Read your calendar and book the meetings an agent arranges.',
    scopes: ['calendar.readonly', 'calendar.events'],
    actions: [
      read('events.list', 'List events'),
      write('events.create', 'Create an event'),
      write('events.update', 'Move an event'),
      destroy('events.delete', 'Delete an event'),
    ],
  },
  {
    slug: 'zendesk',
    name: 'Zendesk',
    glyph: '🎧',
    accent: '#03363d',
    blurb: 'Triage tickets and reply to customers with the right context.',
    scopes: ['tickets:read', 'tickets:write'],
    actions: [
      read('tickets.list', 'List tickets'),
      read('tickets.get', 'Read a ticket'),
      write('tickets.reply', 'Reply to a ticket'),
      write('tickets.update', 'Update a ticket'),
      destroy('tickets.delete', 'Delete a ticket'),
    ],
  },
  {
    slug: 'apollo',
    name: 'Apollo',
    glyph: '🔭',
    accent: '#5b6cff',
    blurb: 'Source and enrich contacts for outbound work.',
    scopes: ['contacts:read', 'contacts:write'],
    actions: [
      read('contacts.search', 'Search contacts'),
      read('contacts.get', 'Read a contact'),
      write('contacts.create', 'Add a contact'),
      write('sequences.add', 'Add to a sequence'),
      destroy('contacts.delete', 'Delete a contact'),
    ],
  },
  {
    slug: 'fs',
    name: 'Filesystem',
    glyph: '🗂️',
    accent: '#f5b544',
    blurb: 'The agent’s own sandbox volume. Your machine is never mounted.',
    scopes: ['sandbox:read', 'sandbox:write'],
    actions: [
      read('read', 'Read a file'),
      write('write', 'Write a file'),
      destroy('delete', 'Delete a file'),
    ],
  },
];

const BY_SLUG = new Map(CONNECTORS.map((c) => [c.slug, c]));

export function getConnector(slug: string): Connector | undefined {
  return BY_SLUG.get(slug);
}

export function connectorName(slug: string): string {
  return BY_SLUG.get(slug)?.name ?? slug;
}

export function connectorGlyph(slug: string): string {
  return BY_SLUG.get(slug)?.glyph ?? '🔌';
}

export function connectorAccent(slug: string): string {
  return BY_SLUG.get(slug)?.accent ?? '#7c9cff';
}

/** Every action name in the catalogue, for the policy editor's datalist. */
export function allActionNames(): string[] {
  const set = new Set<string>();
  for (const c of CONNECTORS) for (const a of c.actions) set.add(a.action);
  return [...set].sort();
}

/** Risk of a concrete action, used to colour the audit log. */
export function riskOf(service: string, action: string): ActionRisk | null {
  const connector = BY_SLUG.get(service);
  if (!connector) return null;
  const exact = connector.actions.find((a) => a.action === action);
  if (exact) return exact.risk;
  const prefix = connector.actions.find((a) => a.action.endsWith('.*') && action.startsWith(a.action.slice(0, -1)));
  return prefix?.risk ?? null;
}

/**
 * Build the default policy for a connector from its action risks.
 * Used when a user connects a new service: reads open, writes reviewed,
 * destructive actions blocked.
 */
export function policyForConnector(slug: string): { service: string; action: string; decision: 'allow' | 'review' | 'block'; note: string }[] {
  const connector = BY_SLUG.get(slug);
  if (!connector) return [];
  return connector.actions.map((a) => ({
    service: slug,
    action: a.action,
    decision: a.risk === 'read' ? 'allow' : a.risk === 'write' ? 'review' : 'block',
    note: a.label,
  }));
}
