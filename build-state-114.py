#!/usr/bin/env python3
"""Build the 114-agent runner state: live 74-agent state + 40 second-batch agents.

Reads:
  /tmp/state-live.json            (fresh pull of /var/lib/teamz-runner/state.json, 74 agents)
  ~/workspace/teamz/new-agents-40-batch2.json  (40 agents with systemPrompt + firstJob)
Writes:
  /tmp/state-114.json

Each new agent gets: id, name, endpointUrl http://127.0.0.1:8897/chat,
provider + model (from the JSON), systemPrompt (from the JSON).
Each new agent gets a first job:
  - type "job"  -> product job job-<slug> with draft/review/implement stages,
    interval everyMs 3600000 (1h), lastRunAt 0 (due immediately).
  - type "cron" -> cronJob with the given cron expression.
Validates: 114 agents, every agent has a job/cron, no duplicate ids,
no new agent on apisfreellm/freeai/ovh, Reviewer prompt unchanged.
"""
import json, sys, collections

LIVE = "/tmp/state-live.json"
BATCH2 = "/home/hatch/workspace/teamz/new-agents-40-batch2.json"
OUT = "/tmp/state-114.json"

state = json.load(open(LIVE))
batch2 = json.load(open(BATCH2))

assert len(batch2) == 40, f"batch2 has {len(batch2)} agents, expected 40"
existing_ids = {a["id"] for a in state["agents"]}
assert len(state["agents"]) == 74, f"live state has {len(state['agents'])} agents, expected 74"

# Provider spread check for batch 2
spread2 = collections.Counter(a["provider"] for a in batch2)
print("batch2 spread:", dict(spread2))
for p in ("apisfreellm", "freeai", "ovh"):
    assert spread2.get(p, 0) == 0, f"batch2 must not use {p}"
assert set(spread2) <= {"groq", "gemini", "kilo", "pollinations"}, f"unexpected provider in batch2: {set(spread2)}"

# Model per provider
MODEL = {"groq": "qwen/qwen3.8-27b", "gemini": "gemini-3.5-flash-lite",
         "kilo": "kilo-auto/free", "pollinations": "openai"}

new_agents = []
new_jobs = []
new_crons = []
for a in batch2:
    aid = a["id"]
    assert aid not in existing_ids, f"duplicate agent id: {aid}"
    assert a["model"] == MODEL[a["provider"]], f"{aid}: model {a['model']} != {MODEL[a['provider']]} for {a['provider']}"
    new_agents.append({
        "id": aid,
        "name": a["name"],
        "endpointUrl": "http://127.0.0.1:8897/chat",
        "provider": a["provider"],
        "model": a["model"],
        "systemPrompt": a["systemPrompt"],
    })
    fj = a["firstJob"]
    slug = aid.replace("agent-", "")
    if fj["type"] == "cron":
        new_crons.append({
            "id": f"cron-{slug}",
            "agentId": aid,
            "cron": fj["cron"],
            "prompt": fj["prompt"],
            "enabled": True,
            "lastRunAt": 0,
        })
    else:
        # product job with draft -> review -> implement stages
        new_jobs.append({
            "id": f"job-{slug}",
            "title": fj["title"],
            "agentId": aid,
            "type": "job",
            "status": "active",
            "currentStage": "draft",
            "stages": [
                {"name": "draft", "prompt": fj["prompt"] + "\n\nDraft your plan and the concrete deliverable (a staged patch, a file, or a report). Do NOT call stage_patch in the draft stage."},
                {"name": "review", "prompt": "Review the draft. Check it against the real mem20 code/tree/history. Approve it only if it is verifiable and does not remove features or fake anything. If it is wrong, say exactly what to fix."},
                {"name": "implement", "prompt": fj["prompt"] + "\n\nImplement the plan. Use repo_read to verify against the real code, then stage_patch to stage the change (jobId is this job's id). Produce a real, verifiable artifact."},
            ],
            "everyMs": 3600000,
            "lastRunAt": 0,
        })

state["agents"].extend(new_agents)
state["jobs"].extend(new_jobs)
state["cronJobs"].extend(new_crons)

# --- Validation ---
assert len(state["agents"]) == 114, f"expected 114 agents, got {len(state['agents'])}"
ids = [a["id"] for a in state["agents"]]
assert len(set(ids)) == 114, "duplicate agent ids"
# every agent has a job or cron
job_agents = {j["agentId"] for j in state["jobs"]}
cron_agents = {c["agentId"] for c in state["cronJobs"]}
missing = [a["id"] for a in state["agents"] if a["id"] not in job_agents and a["id"] not in cron_agents]
assert not missing, f"agents without work: {missing}"
# Reviewer prompt unchanged (sole decision-maker)
rev = [a for a in state["agents"] if a["id"] == "agent-reviewer"][0]
assert "SOLE decision-maker" in rev["systemPrompt"], "Reviewer prompt lost sole-decision-maker"
# provider spread
spread = collections.Counter(a.get("provider") or "pollinations" for a in state["agents"])
print("total spread:", dict(spread))
print(f"agents: {len(state['agents'])} | cronJobs: {len(state['cronJobs'])} | jobs: {len(state['jobs'])}")
print(f"new agents: {len(new_agents)} | new jobs: {len(new_jobs)} | new crons: {len(new_crons)}")

json.dump(state, open(OUT, "w"), indent=2)
print("wrote", OUT)
