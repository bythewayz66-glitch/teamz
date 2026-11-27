#!/usr/bin/env python3
"""Add FUTURE work for all 104 agents to the runner state.

Reads future-work-104.json + the live 104-agent state, and adds:
  * 91 future product jobs (id job-future-<slug>, implement -> upgrade -> document)
    for the "job"-type entries, due 1h after deploy (lastRunAt = now, everyMs 1h)
  * 13 future cron jobs (id cron-future-<slug>) for the "cron"-type entries,
    on their staggered schedules, lastRunAt 0 (run on schedule)

After this, every one of the 104 agents has BOTH a current job and a future
job/cron queued, so no agent sits idle.

Usage: python3 build-future-work.py
Reads: ~/workspace/teamz/future-work-104.json, /tmp/state-104-live2.json
Writes: /tmp/state-104-future.json (validated before printing OK)
"""
import json

FW_PATH = "/home/hatch/workspace/teamz/future-work-104.json"
STATE_PATH = "/tmp/state-104-live2.json"
OUT_PATH = "/tmp/state-104-future.json"

UPGRADE_PROMPT = (
    "Push the staged change (if any) to GitHub through the governed push script. "
    "This stage runs the allowlisted command only — it never edits files itself. "
    "The push happens only because the Reviewer approved this stage; the script "
    "re-checks the approval, the branch, and the diff before pushing."
)


def main():
    fw = json.load(open(FW_PATH))
    state = json.load(open(STATE_PATH))
    assert len(fw) == 104, f"expected 104 future entries, got {len(fw)}"
    assert len(state["agents"]) == 104, f"expected 104 agents, got {len(state['agents'])}"

    agent_ids = {a["id"] for a in state["agents"]}
    assert {x["agentId"] for x in fw} == agent_ids, "future-work agent set != live agent set"

    now_ms = 1795748000000  # approx deploy time, for lastRunAt/createdAt
    job_count = 0
    cron_count = 0

    # Current work per agent (for validation): product jobs + crons already in state
    current_agents = set()
    for c in state["cronJobs"]:
        current_agents.add(c["agentId"])
    for j in state["jobs"]:
        for st in j["stages"]:
            current_agents.add(st["agentId"])
    assert current_agents == agent_ids, f"agents missing current work: {agent_ids - current_agents}"

    existing_job_ids = {j["id"] for j in state["jobs"]}
    existing_cron_ids = {c["id"] for c in state["cronJobs"]}

    for x in fw:
        aid = x["agentId"]
        slug = aid.replace("agent-", "", 1)
        if x["type"] == "cron":
            cid = "cron-future-" + slug
            assert cid not in existing_cron_ids, f"duplicate cron id {cid}"
            state["cronJobs"].append({
                "id": cid,
                "name": x["title"] + " (future)",
                "schedule": x["schedule"],
                "type": "prompt",
                "target": x["prompt"],
                "enabled": True,
                "agentId": aid,
                "channelId": "conv-build-room",
                "lastRunAt": 0,
                "runs": [],
            })
            cron_count += 1
        else:
            jid = "job-future-" + slug
            assert jid not in existing_job_ids, f"duplicate job id {jid}"
            state["jobs"].append({
                "id": jid,
                "name": x["title"] + " (future)",
                "description": (
                    f"Future work for {aid}: {x['title']}. "
                    "Queued after the agent's current job. "
                    "Produces a staged patch or report for mem20; "
                    "the push is gated and the Reviewer approves it."
                ),
                "channelId": "conv-build-room",
                "managerAgentId": None,
                "stages": [
                    {
                        "stage": "implement",
                        "agentId": aid,
                        "prompt": x["prompt"],
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
                        "agentId": aid,
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
                        "agentId": aid,
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
                # Due 1h after deploy (lastRunAt=now), so the current job gets
                # the first pass; then this future job runs on the same 1h cadence.
                "schedule": {"kind": "interval", "everyMs": 3600000},
                "enabled": True,
                "lastRunAt": now_ms,
                "runs": [],
                "createdAt": now_ms,
                "updatedAt": now_ms,
                "workdir": "/opt/mem20",
                "allowedCommands": [["sudo", "/opt/teamz-runner/push-mem20.py"]],
            })
            job_count += 1

    # --- Validate ---------------------------------------------------------
    assert len(state["agents"]) == 104
    # every agent has BOTH a current entry and a future entry
    future_agents = set()
    for c in state["cronJobs"]:
        if c["id"].startswith("cron-future-"):
            future_agents.add(c["agentId"])
    for j in state["jobs"]:
        if j["id"].startswith("job-future-"):
            for st in j["stages"]:
                future_agents.add(st["agentId"])
    assert future_agents == agent_ids, f"agents missing future work: {agent_ids - future_agents}"
    assert current_agents == agent_ids, "agents missing current work"
    print(f"agents: {len(state['agents'])} | cronJobs: {len(state['cronJobs'])} (+{cron_count} future) | jobs: {len(state['jobs'])} (+{job_count} future)")
    print(f"agents with current work: {len(current_agents)} | agents with future work: {len(future_agents)} | agents with BOTH: {len(current_agents & future_agents)}")
    # Reviewer prompt intact
    for a in state["agents"]:
        if a["id"] == "agent-reviewer":
            assert "SOLE decision-maker" in a["systemPrompt"]
    print("reviewer prompt OK")

    json.dump(state, open(OUT_PATH, "w"), indent=2)
    print(f"wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
