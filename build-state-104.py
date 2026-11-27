#!/usr/bin/env python3
"""Build the 104-agent runner state: live 74-agent state + 30 second-batch agents.

Reads new-agents-30-batch2.json + the live state.json (74 agents), and produces
a new state.json with:
  * the 30 new agents (id, name, endpointUrl, provider, model, systemPrompt)
  * 30 product jobs for the job-type first jobs (implement -> upgrade -> document)
    (all 30 batch2 first jobs are type "job"; no cron-type in this batch)

Usage: python3 build-state-104.py
Reads: ~/workspace/teamz/new-agents-30-batch2.json, /tmp/state-live.json
Writes: /tmp/state-104.json (validated before printing OK)
"""
import json

NEW_AGENTS_PATH = "/home/hatch/workspace/teamz/new-agents-30-batch2.json"
STATE_PATH = "/tmp/state-live.json"
OUT_PATH = "/tmp/state-104.json"

UPGRADE_PROMPT = (
    "Push the staged change (if any) to GitHub through the governed push script. "
    "This stage runs the allowlisted command only — it never edits files itself. "
    "The push happens only because the Reviewer approved this stage; the script "
    "re-checks the approval, the branch, and the diff before pushing."
)


def main():
    new_agents = json.load(open(NEW_AGENTS_PATH))
    state = json.load(open(STATE_PATH))
    assert len(new_agents) == 30, f"expected 30, got {len(new_agents)}"
    assert len(state["agents"]) == 74, f"expected 74 existing, got {len(state['agents'])}"

    existing_ids = {a["id"] for a in state["agents"]}
    now_ms = 1795747000000  # approx now, for createdAt/updatedAt
    job_count = 0
    cron_count = 0

    # --- 1. Add the 30 agents -------------------------------------------
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

    # --- 2. Add jobs ------------------------------------------------------
    for a in new_agents:
        fj = a["firstJob"]
        agent_id = a["id"]
        if fj["type"] == "cron":
            cron_id = "cron-" + agent_id.replace("agent-", "", 1)
            state["cronJobs"].append({
                "id": cron_id,
                "name": fj["title"],
                "schedule": fj.get("schedule") or fj.get("cron"),
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

    # --- 3. Validate ------------------------------------------------------
    assert len(state["agents"]) == 104, f"agents={len(state['agents'])}"
    assert len({a["id"] for a in state["agents"]}) == 104, "duplicate agent ids"
    # every agent has a job (cron or product)
    job_agent_ids = set()
    for c in state["cronJobs"]:
        job_agent_ids.add(c["agentId"])
    for j in state["jobs"]:
        for st in j["stages"]:
            job_agent_ids.add(st["agentId"])
    missing = [a["id"] for a in state["agents"] if a["id"] not in job_agent_ids]
    print(f"agents: {len(state['agents'])} | cronJobs: {len(state['cronJobs'])} (+{cron_count}) | jobs: {len(state['jobs'])} (+{job_count})")
    print(f"agents with no job/cron entry: {missing}")
    assert not missing, f"agents with no work: {missing}"
    # Reviewer prompt still sole decision-maker
    for a in state["agents"]:
        if a["id"] == "agent-reviewer":
            assert "SOLE decision-maker" in a["systemPrompt"], "reviewer prompt lost sole-decision-maker"
    print("reviewer prompt OK (sole decision-maker)")
    # No NEW agent on forbidden providers
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
