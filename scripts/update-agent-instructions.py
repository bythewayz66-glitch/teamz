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
  - Nov 27, 2026 unstick job: WORKING DISCIPLINE for the 12 agents that
    failed the Reviewer backlog (stage-early, small scope, verify-first,
    search-before-declaring-missing, flag-don't-fill), PRICING_CATALOG for
    the two pricing agents (the 15 real a-la-carte ids + 4 tiers, never
    invent a SKU), and a temporary move of the Reviewer, Triage, and
    Provider Researcher from flapping blockrun-free to apisfreellm.

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

# Working discipline for the agents that failed the Nov 27, 2026 backlog
# jobs (tool-limit rambles, invented evidence, NO-CHANGE on a file that
# exists, unverified claims). Appended to the implement agents that
# produced those failures, so the same stage cannot fail the same way.
WORKING_DISCIPLINE = (
    "WORKING DISCIPLINE — the rules that keep a stage from failing the way the Nov 27 backlog jobs failed. "
    "1. STAGE EARLY — if the work produces a repo change, stage the patch with stage_patch FIRST, before polishing "
    "or writing the report. A stage that ends with no staged patch has produced nothing. "
    "2. SMALL SCOPE — keep the stage small enough to finish inside 25 tool iterations: one file, one fix, one "
    "verified claim at a time. If the job is bigger than one hunk, do the single most impactful hunk and list the "
    "rest as follow-ups. "
    "3. VERIFY FIRST — verify every claim against the live repo with repo_read before writing it into an output; "
    "quote the file and line you read. Never assert a number, a path, or a licence you have not read yourself in "
    "this run. "
    "4. SEARCH BEFORE DECLARING MISSING — a file or claim is missing only after a repo-wide find and grep turn up "
    "nothing; never declare it missing after checking one path. "
    "5. FLAG, DON'T FILL — anything you could not verify gets flagged as unverified, never a plausible substitute. "
    "6. For report jobs: write the report skeleton to the file first, then fill it in; keep the report short enough "
    "to complete."
)

# Real catalog grounding for the two pricing agents (Nov 27, 2026 unstick
# job). The pricing job failed because its design invented 12 SKU ids.
# Source of truth: mem20shopz/mem20shopz/catalog.json on the live repo.
PRICING_CATALOG = (
    "PRICING_CATALOG — THE ONLY SKUs THAT EXIST. Source of truth: mem20shopz/mem20shopz/catalog.json on the live "
    "repo at /opt/mem20. Before proposing or building ANY price, you MUST repo_read catalog.json and use ONLY the "
    "ids you find there. ONLY these ids exist — never invent a SKU id; if an id is not in this list it does not "
    "exist, and any price table containing an id outside this list is invalid and must be rejected, not patched "
    "around. A-LA-CARTE SKUs (15, currently unpriced): foundation-single (Foundation, one_time), fleet-starter "
    "(Fleet Starter, one_time), hosting-monthly (Managed Hosting, subscription), ops-audit (Operations Audit, "
    "one_time), control-plane-setup (Control Plane Setup, one_time), oncall-monthly (On-Call, subscription), "
    "memory-tiering (Memory Tiering, one_time), agent-fleet-build (Agent Fleet Build, one_time), "
    "intelligence-monthly (Intelligence Retainer, subscription), asset-pipeline (Asset Pipeline, one_time), "
    "game-vertical (Game Vertical, one_time), studio-monthly (Studio Retainer, subscription), migration "
    "(Migration, one_time), training (Team Training, one_time), priority-support-monthly (Priority Support, "
    "subscription). TIER SKUs (4, ALREADY PRICED — never propose for them): team $6,000/yr, business $18,000/yr, "
    "scale $36,000/yr, enterprise $80,000/yr. RULES: 1. Only the 19 ids above exist. Never invent a SKU id. Ids "
    "such as fleet-cluster, ops-incident-response, ops-ha-hardening, intel-audit, intel-model-tuning, "
    "intel-custom-pipeline, creative-prompt-pack, creative-agent-design, creative-workflow-build, "
    "support-advisory, support-dedicated, and support-enterprise-sla DO NOT EXIST and must never appear in a "
    "price table. 2. Always repo_read catalog.json before proposing or building prices, and re-check every id and "
    "kind against what it actually contains. 3. kind must match the catalog kind for each SKU exactly (one_time "
    "or subscription). 4. Ground every price in the v3 house ladder (Team $6,000 / Business $18,000 / Scale "
    "$36,000 / Enterprise $80,000 per year — see docs/pricing/PRICING_DECISION_2026-11-25.md) and the SKU's "
    "scope. Never use $14,000 as a price — that is the blended ACV, a portfolio average, never a sellable price."
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
    # Nov 27, 2026 unstick job: the fetch_url block above was already
    # appended by the earlier fix and lives in this agent's prompt; the
    # new block below is what gets appended now (marker must be new).
    "agent-website-currency-agent": (
        "VERIFY PATHS BEFORE YOU CLAIM — before you write that a path does or does not exist, repo_read the file "
        "in this run and quote what you found. A homepage card, a series page, or any repo path is real only if "
        "you read it. Never deny a path exists on the strength of a doc or a guess."
    ),
    # Nov 27, 2026 unstick job: the STRANDED block above was already
    # appended by the earlier fix and lives in this agent's prompt; the
    # new block below is what gets appended now (marker must be new).
    # Pollinations is OUT OF CREDITS and blockrun-free is flapping, so
    # the old "Prefer pollinations, blockrun-free, or grexlabs" is stale.
    "agent-provider-researcher": (
        "PROVIDER HEALTH — Nov 27, 2026: pollinations is OUT OF CREDITS (do not assign it), blockrun-free is "
        "flapping with free-model-capacity 429s, gemini and groq are quota-exhausted until their daily reset. "
        "Prefer apisfreellm and grexlabs until new providers are wired in. Never assign a provider that is "
        "backed off or known dead; a reassignment to a dead provider is worse than no reassignment."
    ),
    # Nov 27, 2026 unstick job: the agents that failed the Reviewer
    # backlog, each with the discipline that prevents its failure mode.
    # Pricing agents get the catalog block first, then the discipline.
    "agent-pricing-strategist": PRICING_CATALOG + "\n\n" + WORKING_DISCIPLINE,
    "agent-billing-support": PRICING_CATALOG + "\n\n" + WORKING_DISCIPLINE,
    "agent-sales-agent": WORKING_DISCIPLINE,
    "agent-customer-success": WORKING_DISCIPLINE,
    "agent-marketing-agent": WORKING_DISCIPLINE,
    "agent-partnership-scout": WORKING_DISCIPLINE,
    "agent-legal-reviewer": WORKING_DISCIPLINE + (
        " QUOTE WITH LINE — every finding must quote the exact wording and the file and line you read in this "
        "run. If the central claim is not in the file, say so and pivot; never invent the evidence."
    ),
    "agent-competitor-analyst": WORKING_DISCIPLINE + (
        " OFFICIAL SOURCES ONLY — competitor prices and features come only from the competitor's own public docs "
        "or pricing pages, cited with URL and access date. Secondary blogs are not evidence."
    ),
    "agent-performance-engineer": WORKING_DISCIPLINE + (
        " MEASURE ONLY WHAT YOU RUN — report only timings you measured yourself in this run, with the exact "
        "command, host, python version, and timestamp for each number. A report with no command lines is not a "
        "report."
    ),
    "agent-database-engineer": WORKING_DISCIPLINE + (
        " PROVE IT BEFORE AND AFTER — reproduce the defect with an execution test in /tmp against a copy of the "
        "code, then show the same test passing after the fix. Never edit the repo to test."
    ),
    "agent-api-designer": WORKING_DISCIPLINE + (
        " A WHEEL LISTING IS NOT PROOF — verify a packaging fix by building the wheel, installing it, and "
        "running the repo's own verify script against the installed files. Only a booting installed package "
        "verifies the fix."
    ),
}

# Live provider moves (Nov 27, 2026 unstick job): temporary only.
# The Reviewer, Triage, and Provider Researcher are on blockrun-free,
# which is flapping with "Free model capacity exhausted" 429s — the
# Reviewer cannot answer and the queue cannot drain. apisfreellm answered
# the repo-verification probe live (Nov 27 ~16:35 MST), so the three gate
# agents move there until a stronger home is wired (OpenRouter/DeepInfra
# via the $20 split ~18:10 MST, or the keys-pull). The Orchestrator and
# Prompt Engineer are already on apisfreellm; no move needed.
# The Nov 27 (earlier fix) pollinations moves were REMOVED from this dict:
# pollinations is OUT OF CREDITS, those moves already applied live, and
# re-emitting them would move agents back onto a dead provider. The 11
# agents still on pollinations are the Provider Researcher's rescue work,
# not this script's.
PROVIDER_MOVES = {
    "agent-reviewer": ("apisfreellm", "free-ai"),
    "agent-triage": ("apisfreellm", "free-ai"),
    "agent-provider-researcher": ("apisfreellm", "free-ai"),
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
