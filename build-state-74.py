#!/usr/bin/env python3
"""Build the new Teamz runner state: 34 existing + 40 new agents = 74.

Reads new-agents-40.json + the current state.json, and produces a new
state.json with:
  * the 40 new agents (id, name, endpointUrl, provider, model, systemPrompt)
  * 3 cronJobs for the cron-type first jobs
  * 37 product jobs for the job-type first jobs (implement -> upgrade -> document)
  * the Reviewer agent's systemPrompt updated to sole decision-maker

Usage: python3 build-state-74.py
Reads: ~/workspace/teamz/new-agents-40.json, /tmp/state-current.json
Writes: /tmp/state-new.json (validated before printing OK)
"""
import json

NEW_AGENTS_PATH = "/home/hatch/workspace/teamz/new-agents-40.json"
STATE_PATH = "/tmp/state-current.json"
OUT_PATH = "/tmp/state-new.json"

REVIEWER_PROMPT = (
    "You are Reviewer, the SOLE decision-maker for Teamz. Jesse is the founder only "
    "and approves nothing — every decision, including releases, spending, public "
    "actions, and destructive changes, comes to you and only you. You decide quickly "
    "and in writing, with the decision and its reason, so there is a record. You must "
    "apply the standing rules to every decision: no removing features and no faking "
    "them (completion is the only acceptable result); verify every claim against the "
    "real code, tree, and git history (never assume docs are accurate); the repo-root "
    "AGENTS.md is canonical and trumps all other rules docs; mem20core and mem20corez "
    "are distinct components — never merge them. For high-stakes decisions (a release, "
    "spending money, publishing something public, or deleting/destroying anything), "
    "apply extra care: approve only when the work is verified, the change is exactly "
    "what was asked for, and nothing is deleted or faked. For a routine code or doc "
    "change through the governed push path, approve it when it is a small, verified "
    "correction (nothing deleted, no workflow files, no secrets). Deny anything that "
    "removes a feature, fakes a result, deletes data, touches a blocked path, or is "
    "unverified — and say plainly why."
)

UPGRADE_PROMPT = (
    "Push the staged change (if any) to GitHub through the governed push script. "
    "This stage runs the allowlisted command only — it never edits files itself. "
    "The push happens only because the Reviewer approved this stage; the script "
    "re-checks the approval, the branch, and the diff before pushing."
)


def main():
    new_agents = json.load(open(NEW_AGENTS_PATH))
    state = json.load(open(STATE_PATH))
    assert len(new_agents) == 40, f"expected 40, got {len(new_agents)}"
    assert len(state["agents"]) == 34, f"expected 34 existing, got {len(state['agents'])}"

    existing_ids = {a["id"] for a in state["agents"]}
    now_ms = 1795745000000  # approx now, for createdAt/updatedAt

    # --- 1. Add the 40 agents -------------------------------------------
    for a in new_agents:
        assert a["id"] not in existing_ids, f"duplicate id {a['id']}"
        assert a["provider"] in ("kilo", "gemini", "groq", "pollinations"), a["provider"]
        state["agents"].append({
            "id": a["id"],
            "name": a["name"],
            "endpointUrl": "http://127.0.0.1:8897/chat",
            "model": a["model"],
            "provider": a["provider"],
            "systemPrompt": a["systemPrompt"],
        })

    # --- 2. Update the Reviewer prompt -----------------------------------
    for a in state["agents"]:
        if a["id"] == "agent-reviewer":
            a["systemPrompt"] = REVIEWER_PROMPT
            print("reviewer prompt updated")

    # --- 3. Add jobs ------------------------------------------------------
    cron_count = 0
    job_count = 0
    for a in new_agents:
        fj = a["firstJob"]
        agent_id = a["id"]
        if fj["type"] == "cron":
            cron_id = "cron-" + agent_id.replace("agent-", "", 1)
            state["cronJobs"].append({
                "id": cron_id,
                "name": f"{fj['title']}",
                "schedule": fj["schedule"],
                "type": "prompt",
                "target": fj["prompt"],
                "enabled": True,
                "agentId": agent_id,
                "channelId": "conv-build-room",
                "lastRunAt": 0,
                "runs": [],
            })
            cron_count += 1
        else:
            # product job: implement -> upgrade (gated push) -> document
            job_id = "job-" + agent_id.replace("agent-", "", 1)
            state["jobs"].append({
                "id": job_id,
                "name": fj["title"],
                "description": (
                    f"First job for {a['name']}: {fj['title']}. "
                    "Produces a staged patch or report for mem20; "
                    "the push is gated and the Reviewer approves it."
                ),
                "channelId": "conv-build-room",
                "managerAgentId": None,
                "stages": [
                    {
                        "stage": "implement",
                        "agentId": agent_id,
                        "prompt": fj["prompt"],
                        "expectedOutput": (
                            "The completed work: a staged patch summary (file, old text, "
                            "new text, why) OR a written report/file, with evidence. "
                            "If nothing is verifiably wrong, reply NO-CHANGE."
                        ),
                        "contextStages": [],
                        "humanInput": False,
                    },
                    {
                        "stage": "upgrade",
                        "agentId": agent_id,
                        "prompt": UPGRADE_PROMPT,
                        "expectedOutput": (
                            "The push record: the commit hash and remote main, or "
                            "NOTHING-TO-PUSH when no patch was staged."
                        ),
                        "contextStages": ["implement"],
                        "humanInput": True,
                        "flags": {"requiresReview": True},
                        "command": {"argv": ["sudo", "/opt/teamz-runner/push-mem20.py"]},
                    },
                    {
                        "stage": "document",
                        "agentId": agent_id,
                        "prompt": (
                            "Write a short report of this job: what changed, what was "
                            "pushed (commit hash, remote main) or why nothing was pushed, "
                            "and what is unfinished. Quote the push record; do not invent findings."
                        ),
                        "expectedOutput": (
                            "A short report: the change (if any), the push record, "
                            "unfinished work."
                        ),
                        "contextStages": ["implement", "upgrade"],
                        "humanInput": False,
                    },
                ],
                "currentStageIndex": 0,
                "status": "active",
                "schedule": {"kind": "interval", "everyMs": 3600000},
                "enabled": True,
                "lastRunAt": 0,
                "runs": [],
                "createdAt": now_ms,
                "updatedAt": now_ms,
                "workdir": "/opt/mem20",
                "allowedCommands": [["sudo", "/opt/teamz-runner/push-mem20.py"]],
            })
            job_count += 1

    # --- 3b. Give the 4 agents with no job a cron job ----------------------
    # Scout, Pixel, Sage (seed agents) and the Reviewer have no cron/job.
    # The Reviewer decides on demand; give it a weekly self-audit so it
    # also has recorded work. Scout/Pixel/Sage get real mem20 work.
    extra_crons = [
        {
            "id": "cron-hourly-scout",
            "name": "Hourly: Scout mem20 opportunity scan",
            "schedule": "0 * * * *",
            "target": (
                "Scout the mem20 repo, docs, and GitHub issues for the single most "
                "impactful unfiled issue or improvement right now (a real gap, bug, or "
                "opportunity you can verify from the code/tree/history). Draft it as a "
                "GitHub issue (title + body with evidence) and report the draft. Do not "
                "file an issue that already exists (#456-#465) and do not invent a problem."
            ),
            "agentId": "agent-scout",
        },
        {
            "id": "cron-daily-pixel",
            "name": "Daily: Pixel mem20 visual/UX check",
            "schedule": "0 8 * * *",
            "target": (
                "Review mem20's public surface (docs site, homepage, README) for visual "
                "and UX issues you can verify (broken links, stale numbers, layout or "
                "readability problems). List each issue with the exact file/URL and what "
                "is wrong, and stage the smallest correction for the clearest one via "
                "stage_patch. Do not claim a problem you cannot verify from the live site or repo."
            ),
            "agentId": "agent-pixel",
        },
        {
            "id": "cron-weekly-sage",
            "name": "Weekly: Sage mem20 review",
            "schedule": "0 9 * * 1",
            "target": (
                "Review the past week's mem20 changes (git history, merged/staged work, "
                "issues #456-#465) for quality and coherence: what improved, what regressed, "
                "what contradicts the root AGENTS.md or the no-faking rule. Write a short "
                "review with each point sourced by commit or file. Do not praise work that "
                "is only a stub."
            ),
            "agentId": "agent-sage",
        },
        {
            "id": "cron-weekly-reviewer-audit",
            "name": "Weekly: Reviewer decision audit",
            "schedule": "0 10 * * 1",
            "target": (
                "Audit your own Reviewer decisions from the past week (approval records in "
                "the runner state): were they consistent with the standing rules (no removing "
                "features, no faking, verify against real code/tree/history, root AGENTS.md "
                "canonical)? List any decision that was wrong or inconsistent and what the "
                "correct decision should have been. This is a self-audit — be honest."
            ),
            "agentId": "agent-reviewer",
        },
    ]
    for c in extra_crons:
        state["cronJobs"].append({
            "id": c["id"],
            "name": c["name"],
            "schedule": c["schedule"],
            "type": "prompt",
            "target": c["target"],
            "enabled": True,
            "agentId": c["agentId"],
            "channelId": "conv-build-room",
            "lastRunAt": 0,
            "runs": [],
        })
    cron_count += len(extra_crons)

    # --- 4. Validate ------------------------------------------------------
    assert len(state["agents"]) == 74, f"agents={len(state['agents'])}"
    assert len({a["id"] for a in state["agents"]}) == 74, "duplicate agent ids"
    assert len(state["cronJobs"]) == 29 + cron_count, f"cronJobs={len(state['cronJobs'])}"
    assert len(state["jobs"]) == 2 + job_count, f"jobs={len(state['jobs'])}"
    # every agent has a job (cron or product)
    job_agent_ids = set()
    for c in state["cronJobs"]:
        job_agent_ids.add(c["agentId"])
    for j in state["jobs"]:
        for st in j["stages"]:
            job_agent_ids.add(st["agentId"])
    missing = [a["id"] for a in state["agents"] if a["id"] not in job_agent_ids]
    # The Reviewer also decides on demand (approval dispatches); it now has
    # a weekly audit cron too, so it should not be missing.
    print(f"agents: {len(state['agents'])} | cronJobs: {len(state['cronJobs'])} (+{cron_count}) | jobs: {len(state['jobs'])} (+{job_count})")
    print(f"agents with no job/cron entry: {missing}")
    assert not missing, f"agents with no work: {missing}"
    # Reviewer prompt check
    for a in state["agents"]:
        if a["id"] == "agent-reviewer":
            assert "SOLE decision-maker" in a["systemPrompt"], "reviewer prompt not updated"
            assert "Jesse is the founder only" in a["systemPrompt"]
    print("reviewer prompt OK (sole decision-maker)")
    # No NEW agent on forbidden providers (existing Personal Growth Mentor
    # stays on apisfreellm by the earlier rebalance decision; Researcher is
    # the only agent on ovh).
    new_ids = {a["id"] for a in new_agents}
    bad = [a["id"] for a in state["agents"] if a["id"] in new_ids and a.get("provider") in ("apisfreellm", "freeai", "ovh")]
    assert not bad, f"NEW agents on forbidden providers: {bad}"
    ovh = [a["id"] for a in state["agents"] if a.get("provider") == "ovh"]
    assert ovh == ["agent-provider-researcher"], f"ovh agents: {ovh}"
    print("provider check OK (ovh = Researcher only; no new agents on apisfreellm/freeai)")

    json.dump(state, open(OUT_PATH, "w"), indent=2)
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
