import json

# Move the four reasoning roles onto blockrun (gpt-oss-120b), which just
# answered PING OK (Nov 27, 2026 ~22:15Z) — a capable 120B model, unlike
# the weak free models that could not complete the Triage role
# (nemotron wandered the repo to the iteration limit twice; apisfreellm
# rambled; grexlabs went off-task). Orchestrator stays on apisfreellm
# (dispatching), Drift Monitor + WCA stay on grexlabs (mechanical).
MOVES = {
    "agent-reviewer": ("blockrun", "nvidia/gpt-oss-120b"),
    "agent-triage": ("blockrun", "nvidia/gpt-oss-120b"),
    "agent-prompt-engineer": ("blockrun", "nvidia/gpt-oss-120b"),
    "agent-provider-researcher": ("blockrun", "nvidia/gpt-oss-120b"),
}
path = "/var/lib/teamz-runner/state.json"
state = json.load(open(path))
by = {a["id"]: a for a in state["agents"]}
for aid, (prov, model) in MOVES.items():
    a = by.get(aid)
    if not a:
        print("MISSING:", aid)
        continue
    print(aid, (a.get("provider"), a.get("model")), "->", (prov, model))
    a["provider"] = prov
    a["model"] = model
json.dump(state, open(path, "w"), indent=2)
print("reassignment written")
