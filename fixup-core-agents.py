import json

# Fixup after the grexlabs Reviewer probe misfire (Nov 27, 2026 ~21:39Z):
# 1) Remove the junk hourly cron the grexlabs Reviewer created via
#    create_automation ("noop", cron-mwzi77gm-eu9s7t).
# 2) Re-home the reasoning-heavy core agents off grexlabs (auto:free
#    proved too weak for the Reviewer) onto the two providers that
#    passed the Reviewer verification probe: apisfreellm and blockrun-free.
MOVES = {
    "agent-reviewer": ("apisfreellm", "free-ai"),
    "agent-triage": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-provider-researcher": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-drift-monitor": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    # Orchestrator + Prompt Engineer stay on apisfreellm; WCA stays on
    # grexlabs (its fetch_url probe passed there).
}
JUNK_CRON = "cron-mwzi77gm-eu9s7t"
path = "/var/lib/teamz-runner/state.json"
state = json.load(open(path))
before = len(state.get("cronJobs", []))
state["cronJobs"] = [c for c in state.get("cronJobs", []) if c.get("id") != JUNK_CRON]
print("junk cron removed:", before - len(state["cronJobs"]), "| crons now:", len(state["cronJobs"]))
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
print("fixup written")
