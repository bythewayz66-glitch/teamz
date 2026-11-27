import json

# Re-home the quality-critical gating roles onto blockrun-free
# (nemotron-3.5-lightning): it is the only free provider whose model
# proved it can verify-and-decide correctly (Reviewer probe, Nov 27
# ~21:39Z). apisfreellm's model rambled through repo_read calls and hit
# the 25-iteration limit without answering as Triage (test run 4), so
# Triage/Reviewer/Researcher leave apisfreellm. Prompt Engineer and
# Orchestrator stay on apisfreellm (mechanical roles; verified by the
# test run). Drift Monitor + WCA stay on grexlabs.
MOVES = {
    "agent-reviewer": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-triage": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-provider-researcher": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
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
