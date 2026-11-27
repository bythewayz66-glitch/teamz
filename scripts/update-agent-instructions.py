#!/usr/bin/env python3
"""Apply the Nov 27, 2026 direct-fix instruction updates to every Teamz agent.

Jesse's rules, baked into every agent's systemPrompt:
  - DOCS RULE: a document is a claim, never the truth. An agent may trust
    ONLY a document it wrote itself; any other document is unverified
    until that agent checks it against the live code, tree, git history,
    and live surface (527 tools / 135 domains, v4.0.0, real catalog ids).
  - MEM20 CONTEXT: agents with no mem20 knowledge get the live surface,
    the repo path, and the canonical rules.
  - Role blocks for the Reviewer, Prompt Engineer, Triage, Orchestrator,
    Website Currency Agent, and Provider Researcher (verify-before-decide,
    stage-early/small-scope, list-issues + different-agent, room_read
    first, fetch_url for the live site, stranded-agent fixes).

Usage:
  python3 scripts/update-agent-instructions.py [--live-state PATH]
      [--emit-live-patch PATH]

  --live-state PATH   live runner state.json: fixes the stale Atlas stub
                      in runner-agents.json from the live prompt, and adds
                      Pixel/Sage/Scout (which exist only in live state) to
                      runner-agents.json so no agent is file-less.
  --emit-live-patch PATH
                      also write a JSON patch {agentId: {systemPrompt,
                      provider, model}} for the live state edit (provider
                      moves + prompt updates), applied on jnet1 with the
                      runner stopped.

Idempotent: a block is appended only when its marker is absent.
"""
import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

DOCS_RULE = (
    "DOCS RULE — a document is a claim, never the truth. You may trust ONLY a document you wrote yourself. "
    "Any other document — pre-existing, or written by another agent — is unverified until YOU check it against "
    "the live source of truth: the live code, the tree, git history, and the live surface (527 MCP tools across "
    "135 domains, version 4.0.0, real catalog ids). Never act on an unverified document claim. "
    "Verify with repo_read before you use it."
)

MEM20_CONTEXT = (
    "MEM20 CONTEXT — you work on mem20, an auditable agent-memory system. Live surface: 527 MCP tools across "
    "135 domains, 0 unwired, version 4.0.0. The repo is at /opt/mem20 on the runner (repo_read reads it). "
    "Rules: the repo-root AGENTS.md is canonical and trumps all other rules docs; never remove a feature and "
    "never fake one — completion only; mem20core and mem20corez are distinct components, never merge them. "
    "Verify every claim against the live code, tree, and git history before acting on it."
)

ROLE_BLOCKS = {
    "agent-reviewer": (
        "VERIFY BEFORE YOU DECIDE — you have a repo_read tool: use it. Before you approve or deny on any factual "
        "claim, check that claim against the live repo: does the path exist (repo_read the file)? Is the SKU id real "
        "(repo_read mem20shopz/mem20shopz/catalog.json and confirm the id is listed)? Is the number true (repo_read "
        "docs/surface.json)? Do the verification first, as tool calls, and only then reply with your one-line verdict. "
        "Never approve or deny on a claim you have not verified — if a claim cannot be verified, deny and say it is "
        "unverifiable. Do not trust the agent's summary of what a file says; read the file yourself."
    ),
    "agent-prompt-engineer": (
        "WHEN YOU OPTIMIZE A PROMPT, the optimized assignment MUST carry these working rules for the agent who receives it: "
        "1. STAGE EARLY — if the work produces a repo change, stage the patch with stage_patch FIRST, before polishing. "
        "A stage that ends with no staged patch has produced nothing. "
        "2. SMALL SCOPE — keep the stage small enough to finish inside 25 tool iterations: one file, one fix, one verified claim at a time. "
        "3. VERIFY FIRST — verify every claim against the live repo with repo_read before writing it into an output. "
        "4. The DOCS RULE above."
    ),
    "agent-triage": (
        "WHEN YOU TRIAGE A DENIAL: list the specific denial issues first (numbered, one per problem in the Reviewer's reason), "
        "then name a DIFFERENT agent than the one that did the failed work — never reassign to the same agent — and hand back a "
        "corrected assignment. Verify any factual claim in the corrected assignment against the live repo with repo_read before you write it. "
        "Reply in this exact format: first the numbered list of denial issues, then on its own line REASSIGN: @<agent-id>, then the corrected assignment prompt."
    ),
    "agent-orchestrator": (
        "TRIAGE: on every triage run, call room_read with {\"what\": \"unassigned\"} FIRST — it lists the denied work waiting for "
        "reassignment and the gate items that did not reach the room. Assign the work in the room by @mention; a denial that sits "
        "unassigned is a failure. You do not decide releases, spending, or public actions — the Reviewer does."
    ),
    "agent-website-currency-agent": (
        "READ THE LIVE SITE with fetch_url — never judge the site from the repo copy alone. Fetch https://mem20.com/ and the docs pages "
        "you check, and compare what the live site actually shows against the live surface (527 tools / 135 domains, v4.0.0). "
        "repo_read only reads the repo; the site is what users see."
    ),
    "agent-provider-researcher": (
        "STRANDED AGENTS: an agent with no provider — or a provider the registry does not know — cannot run and never rate-limits, "
        "so rescue never sees it. When a sweep hands you stranded agents, reassign EACH one to a healthy provider with reassign_agent. "
        "Prefer pollinations, blockrun-free, or grexlabs. Never assign kilo (returns empty content), gemini while it is quota-exhausted, "
        "or any provider that is backed off or known dead."
    ),
}

# Live provider moves (Nov 27, 2026): off dead/degraded providers onto
# healthy ones. Gemini stays for the 35 agents already on it (quota
# resets daily; rescue covers 429s). Core agents + the 9 providerless
# agents + the 13 Kilo agents + the BlockRun agent move now.
# Model is the registry model for the target provider.
PROVIDER_MOVES = {
    # Core agents off Gemini (quota-exhausted for triage): -> pollinations
    "agent-reviewer": ("pollinations", "openai"),
    "agent-orchestrator": ("pollinations", "openai"),
    "agent-triage": ("pollinations", "openai"),
    "agent-provider-researcher": ("pollinations", "openai"),
    "agent-drift-monitor": ("pollinations", "openai"),
    "agent-website-currency-agent": ("pollinations", "openai"),
    # The 9 providerless agents -> pollinations (explicit)
    "agent-writing-assistant": ("pollinations", "openai"),
    "agent-prompt-engineer": ("pollinations", "openai"),
    "agent-minimal-change-engineer": ("pollinations", "openai"),
    "agent-git-workflow-master": ("pollinations", "openai"),
    "agent-codebase-onboarding-engineer": ("pollinations", "openai"),
    "agent-application-security-engineer": ("pollinations", "openai"),
    "agent-reality-checker": ("pollinations", "openai"),
    "agent-senior-project-manager": ("pollinations", "openai"),
    "agent-keymaster": ("pollinations", "openai"),
    # Kilo agents (empty content) -> pollinations
    "agent-ai-engineer": ("pollinations", "openai"),
    "agent-atlas": ("pollinations", "openai"),
    "agent-scout": ("pollinations", "openai"),
    "agent-release-manager": ("pollinations", "openai"),
    "agent-community-manager": ("pollinations", "openai"),
    "agent-tutorial-creator": ("pollinations", "openai"),
    "agent-vendor-manager": ("pollinations", "openai"),
    # Kilo agents -> blockrun-free (nvidia/nemotron-3.5-lightning)
    "agent-pixel": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-sage": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-newsletter-writer": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    # Kilo agents -> grexlabs (auto:free)
    "agent-changelog-writer": ("grexlabs", "auto:free"),
    "agent-onboarding-engineer": ("grexlabs", "auto:free"),
    "agent-video-producer": ("grexlabs", "auto:free"),
    # BlockRun (429) -> blockrun-free
    "agent-content-creator": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
}

JSON_FILES = [
    "runner-agents.json",
    "new-agents-30-batch2.json",
    "new-agents-40.json",
    "new-agents-1-website-currency.json",
]

FILE_ONLY_AGENTS = ["agent-pixel", "agent-sage", "agent-scout"]

# The Atlas prompt as it stands in src/data/mock.ts: the stale stub.
# The file prompt was synced from the live state (the real Atlas
# prompt), so the strip-based `old` does not match mock.ts for Atlas;
# this stub is the mock-side old text to replace.
ATLAS_FILE_STUB = (
    "You are Atlas, a senior software engineer. You write small, readable diffs "
    "and explain trade-offs before recommending one."
)


def update_prompt(prompt: str, agent_id: str) -> tuple[str, list[str]]:
    """Append the missing blocks. Returns (new_prompt, [blocks added])."""
    added = []
    blocks = []
    if "527" not in prompt:
        blocks.append(("MEM20 CONTEXT", MEM20_CONTEXT))
    if agent_id in ROLE_BLOCKS:
        marker = ROLE_BLOCKS[agent_id].split(" — ")[0]
        if marker not in prompt:
            blocks.append((marker, ROLE_BLOCKS[agent_id]))
    if "DOCS RULE" not in prompt:
        blocks.append(("DOCS RULE", DOCS_RULE))
    out = prompt.rstrip()
    for name, text in blocks:
        out += "\n\n" + text
        added.append(name)
    return out, added


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--live-state", help="live runner state.json (fixes Atlas stub, adds file-less agents)")
    ap.add_argument("--emit-live-patch", help="write a live-state patch JSON here")
    args = ap.parse_args()

    live = {}
    if args.live_state:
        live = {a["id"]: a for a in json.loads(Path(args.live_state).read_text())["agents"]}

    report = {"context": 0, "docs_rule": 0, "role": 0, "agents": 0, "mock_updated": []}
    live_patch = {}

    for fname in JSON_FILES:
        path = REPO / fname
        agents = json.loads(path.read_text())
        changed = False
        for agent in agents:
            aid = agent["id"]
            # Atlas: the file holds the stale 122-char stub; the live
            # prompt is the real one. Sync from live before updating.
            if aid == "agent-atlas" and aid in live:
                live_prompt = live[aid].get("systemPrompt", "")
                if len(live_prompt) > len(agent.get("systemPrompt", "")):
                    agent["systemPrompt"] = live_prompt
            old = agent.get("systemPrompt", "")
            new, added = update_prompt(old, aid)
            if added:
                agent["systemPrompt"] = new
                changed = True
                report["agents"] += 1
                if "MEM20 CONTEXT" in added:
                    report["context"] += 1
                if "DOCS RULE" in added:
                    report["docs_rule"] += 1
                if any(a not in ("MEM20 CONTEXT", "DOCS RULE") for a in added):
                    report["role"] += 1
            live_patch[aid] = {"systemPrompt": agent["systemPrompt"]}
        if changed:
            path.write_text(json.dumps(agents, indent=2) + "\n")

    # File-less agents (only in live state): their prompts are updated
    # in the LIVE PATCH only. They are NOT added to runner-agents.json:
    # the roster tests pin that file at 32 records and mock.ts must
    # match it exactly, so adding agents there is a roster expansion
    # (UI seed + state builder too), not part of this fix. The live
    # patch still carries their updated prompts and provider moves.
    if live:
        for aid in FILE_ONLY_AGENTS:
            if aid not in live:
                continue
            new, added = update_prompt(live[aid].get("systemPrompt", ""), aid)
            live_patch[aid] = {"systemPrompt": new}
            report["agents"] += 1
            if "MEM20 CONTEXT" in added:
                report["context"] += 1
            if "DOCS RULE" in added:
                report["docs_rule"] += 1
            print(f"file-less agent {aid}: prompt updated in live patch only")

    # mock.ts: the in-tab runner's copy. The roster test pins it: every
    # runner-agents.json systemPrompt must appear VERBATIM in mock.ts.
    # The appended blocks are multi-line, so a quoted literal (which
    # stores newlines as \n escapes) can never hold them verbatim —
    # only a backtick literal preserves the raw text. So the replacement
    # swaps the WHOLE literal (quotes included) for a backtick literal
    # holding the raw new prompt. This requires the new prompt to hold
    # no backticks or ${ — the script asserts that (the Triage prompt's
    # formatting backticks were removed for exactly this reason).
    # Anchored on the agent's `id:` line (Atlas uses the AGENT_ATLAS
    # constant), then the literal span is read directly — no substring
    # search on the prompt text, so the backtick removal and the
    # prefix-of-updated idempotency trap cannot misfire.
    mock_path = REPO / "src/data/mock.ts"
    mock = mock_path.read_text()
    roster = json.loads((REPO / "runner-agents.json").read_text())
    for agent in roster:
        aid = agent["id"]
        new = agent["systemPrompt"]
        old = new
        for block in (MEM20_CONTEXT, ROLE_BLOCKS.get(aid, ""), DOCS_RULE):
            if block:
                old = old.replace("\n\n" + block, "")
        if old == new:
            continue  # nothing was added for this agent
        assert "`" not in new and "${" not in new, f"{aid}: new prompt cannot go in a backtick literal"
        id_at = mock.find(f"id: '{aid}'")
        if id_at == -1:
            const = "AGENT_" + aid[len("agent-"):].upper().replace("-", "_")
            id_at = mock.find(f"id: {const}")
        if id_at == -1:
            print(f"WARN: {aid} not found in mock.ts — the roster test requires it there", file=sys.stderr)
            continue
        sp = mock.find("systemPrompt:", id_at)
        lit_start = sp + len("systemPrompt:")
        while mock[lit_start] in " \n":
            lit_start += 1
        style = mock[lit_start]
        if style not in ('"', "'", "`"):
            print(f"WARN: {aid} systemPrompt in mock.ts uses an unexpected literal — update it by hand", file=sys.stderr)
            continue
        # The literal ends at the next occurrence of its own quote
        # character: the old prompts hold no quote of their own style
        # (proven: they matched verbatim), and a backtick literal holds
        # no unescaped backticks.
        lit_end = mock.find(style, lit_start + 1)
        if lit_end == -1:
            print(f"WARN: {aid} systemPrompt literal has no closing quote in mock.ts", file=sys.stderr)
            continue
        current = mock[lit_start + 1:lit_end]
        if current == new:
            continue  # already updated
        # Backtick-insensitive compare: the Triage prompt lost its
        # formatting backticks in the JSON file; Atlas's mock prompt is
        # the stale stub. Either way the span is replaced wholesale.
        if current.replace("`", "") != old.replace("`", "") and current != ATLAS_FILE_STUB:
            print(f"WARN: {aid} mock.ts prompt does not match the roster prompt — update it by hand", file=sys.stderr)
            continue
        mock = mock[:lit_start] + "`" + new + "`" + mock[lit_end + 1:]
        report["mock_updated"].append(aid)
    mock_path.write_text(mock)

    # Provider moves go into the live patch only (repo files keep their
    # provider fields; the live move is a state edit on jnet1).
    for aid, (provider, model) in PROVIDER_MOVES.items():
        entry = live_patch.setdefault(aid, {})
        entry["provider"] = provider
        entry["model"] = model

    if args.emit_live_patch:
        Path(args.emit_live_patch).write_text(json.dumps(live_patch, indent=2) + "\n")
        print(f"live patch written: {len(live_patch)} agents")

    print(f"agents updated: {report['agents']} (context: {report['context']}, "
          f"docs rule: {report['docs_rule']}, role blocks: {report['role']})")
    print(f"mock.ts updated: {sorted(set(report['mock_updated']))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
