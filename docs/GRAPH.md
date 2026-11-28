# Sections, fleet graph and connections (Phase 4)

Teamz stays standalone: nothing here adds a backend or touches the runner. The
graph and the connections card are computed in the browser from data it already
has. Every number is a recorded count; where no source records a thing, the UI
says so instead of showing zero.

## Sections

`src/data/programmes.ts` groups the 106 fleet agents into eight programmes
(Core governance, Engineering, Platform & reliability, AI & memory, Growth &
go-to-market, Content & community, Business operations, Personal assistants).

**Limit, stated plainly:** the runner has no programme field. This mapping is a
declaration made from each agent's role, kept in one reviewable file, and a
test asserts all 106 ids are assigned exactly once. An agent no programme
claims (for example one created later) shows under "Unassigned", never hidden.
The sidebar has a "By programme" toggle (saved in this browser), and the Fleet
map has a Sections tab.

## Graph

`buildFleetGraph` (`src/lib/graph.ts`, pure, tested) builds nodes and edges from:

| Edge | Source | What a call is |
|---|---|---|
| agent → agent, `@mention` | workspace messages plus the runner's last ~20 channel messages (deduped by id) | one agent-authored message that @mentions another |
| agent → agent, job handoff | job stage order (declared) and stage runs | one `ok` run of stage *i* whose next stage belongs to a different agent |
| agent → GitHub (governed push) | job stages and runs | one `ok` run of the `upgrade` push stage |
| agent → model provider | the runner agent's provider and the usage ledger | one model call, counted per UTC day |
| agent → web tools | the endpoint's toolset (declared) | not recorded anywhere; never counted |

**Dead, active, unknown.** An edge is *active* with at least one call in the
14-day window. It is *dead* only when its source provably reaches back past the
window (it holds an event at least 14 days old) and still saw nothing. If the
source cannot prove that, the edge is *unknown*. A dead edge is drawn dashed
red; unknown edges are hidden unless you ask for them on a selection. The
"Where these numbers come from" panel states each source's reach.

**Busiest three** is ranked by total recorded calls touching the agent in the
window (model calls, mentions in and out, handoffs, pushes), with the
breakdown shown beside each name. **No calls in 14 days** is shown only when
the usage ledger, the message history and (for agents with job stages) the
stage runs all reach back past the window; otherwise the agent is "cannot be
sure", not zero.

### Known limits

- The usage ledger only holds days this browser fetched `/usage`, so model
  counts are lower bounds and a young ledger proves nothing about the past.
- The runner endpoint exposes only its last ~20 channel messages, so @mention
  history older than the workspace's own is not reachable.
- How far back the runner keeps job runs is not recorded here.
- Slack and web-tool calls are not recorded per agent; the graph shows no
  Slack node and no web-tool counts. The runner's `runner-events.jsonl`
  (Phase 0) is on the server and not readable from the browser, so it is not
  used.
- The graph is an SVG for wide screens (106 agent nodes in programme clusters).
  Under 860px it is replaced by the Edges table, which has the same data and
  filters.

## Connections

The agent home's Connections card lists, per agent: model provider, web tools,
GitHub, Slack, Toolchest and MCP servers (`src/lib/connections.ts`). Each row
carries a state, a declared policy and, separately, whether anything
**enforces** it:

- **Web tools** default to "Needs approval" (Gamut's default) but are marked
  **Not enforced**: the runner endpoint does not ask before using them. The
  select records an intent in this browser only.
- **GitHub** is enforced for an agent that owns a push stage: the stage is
  Reviewer-gated and the push script re-checks the approval (`docs/PUSH_PATH.md`;
  not verified live from here). Direct commit and PR tools are blocked.
- **Slack**: the runner posts job results via a webhook; its configuration is not
  visible from the browser. Agents cannot send Slack messages themselves.
- **Toolchest**: read-only tools run, destructive/publishing tools are refused
  by the endpoint (enforced). It reaches the runner host, not an outside service.
- **MCP**: Teamz has no MCP client, so the row says "None".

Tests read `scripts/agent-endpoint/agent.mjs` to check that the tools and block
list the rows describe exist there.

## Second workspace

Not built, deliberately. No real programme needs a separate boundary today, and
workspaces are cheap to add later and expensive to unwind. Revisit if a
programme needs its own members, secrets or approval policy.

## Gate (to be checked live, not claimed here)

From the graph alone, name the three busiest agents and any agent with zero
calls in 14 days; from any agent home, state exactly what it can reach outside
Teamz and under what policy. Both depend on real runner data and a ledger that
has accumulated 14 days, which this PR could not exercise.
