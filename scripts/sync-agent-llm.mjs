#!/usr/bin/env node
/**
 * sync-agent-llm.mjs — apply Provider Researcher reassignments to the UI
 * seed (src/data/mock.ts), LLM fields ONLY.
 *
 *   node scripts/sync-agent-llm.mjs --reassignments <reassignments.json> [--dry-run]
 *
 * The reassignments file is the record the agent endpoint appends to
 * (see scripts/agent-endpoint/agent.mjs `reassign_agent`): one entry per
 * change — { agentId, from: { provider, model }, to: { provider, model },
 * reason, ts }. This script takes the LATEST entry per agent and writes
 * ONLY that agent's `model` (and `endpointUrl`, when the provider's
 * endpoint differs from the current one) in mock.ts. It never touches a
 * system prompt, a skill, or anything else, and it refuses any entry
 * whose provider is not in the validated keyless registry.
 *
 * Why this is a separate repo step: the endpoint can write the runner
 * state (state.json) at runtime, but the UI seed is source code — it
 * changes here, then the UI is rebuilt and redeployed so the served
 * bundle carries the new assignment. Note honestly: the UI persists to
 * localStorage on Jesse's phone after first load, so a seed change only
 * reaches fresh loads — the live assignment is what the endpoint uses
 * and what /runner-state shows.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MOCK_PATH = resolve(process.cwd(), 'src/data/mock.ts');

function fail(message) {
  console.error(`sync-agent-llm: ${message}`);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? null : args[i + 1];
  };
  const dryRun = args.includes('--dry-run');
  const reassignPath = get('--reassignments');
  if (!reassignPath) fail('missing --reassignments <path>');
  const registryPath = get('--registry');
  let registry = null;
  if (registryPath) {
    try {
      registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    } catch {
      fail(`cannot read registry ${registryPath}`);
    }
  }
  let entries;
  try {
    entries = JSON.parse(readFileSync(reassignPath, 'utf-8'));
  } catch (err) {
    fail(`cannot read reassignments ${reassignPath}: ${err.message}`);
  }
  if (!Array.isArray(entries)) fail('reassignments file must be a JSON array');
  const latest = new Map();
  for (const e of entries) {
    if (!e || typeof e.agentId !== 'string' || !e.to || typeof e.to.model !== 'string') continue;
    latest.set(e.agentId, e);
  }
  if (latest.size === 0) {
    console.log('sync-agent-llm: no reassignments to apply');
    return;
  }
  let src = readFileSync(MOCK_PATH, 'utf-8');
  let changed = 0;
  for (const [agentId, entry] of latest) {
    const provider = entry.to.provider ?? 'pollinations';
    if (registry) {
      const known = (registry.providers ?? []).some((p) => p.id === provider && p.keyless === true);
      if (!known) fail(`refusing ${agentId}: provider "${provider}" is not a validated keyless provider in the registry`);
    }
    // Find the agent block by id and replace ONLY its model line.
    const idRe = new RegExp(`(id: '${agentId.replace(/'/g, "\\'")}',[\\s\\S]{0,600}?)model: '[^']*'`);
    const m = idRe.exec(src);
    if (!m) fail(`agent ${agentId} not found in mock.ts (or its model line is out of range)`);
    if (m[0].includes(`model: '${entry.to.model}'`)) {
      console.log(`sync-agent-llm: ${agentId} already on ${entry.to.model} — skipping`);
      continue;
    }
    console.log(
      `sync-agent-llm: ${agentId}: ${entry.from?.provider ?? '?'} / ${entry.from?.model ?? '?'} -> ${provider} / ${entry.to.model} (${entry.reason ?? 'no reason recorded'})`,
    );
    if (!dryRun) {
      src = src.replace(idRe, `$1model: '${entry.to.model}'`);
      changed++;
    }
  }
  if (!dryRun && changed > 0) {
    writeFileSync(MOCK_PATH, src, 'utf-8');
    console.log(`sync-agent-llm: wrote ${changed} model change(s) to src/data/mock.ts — rebuild the UI to serve them`);
  } else if (dryRun) {
    console.log('sync-agent-llm: dry run — no files changed');
  }
}

main();
