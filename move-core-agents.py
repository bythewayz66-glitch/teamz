import json

# Move the 7 core pipeline agents off dead Pollinations (out of credits
# ~21:29Z Nov 27) onto the two healthy free providers, split to avoid
# hammering one. Models from the live registry.
MOVES = {
    "agent-reviewer": ("grexlabs", "auto:free"),
    "agent-orchestrator": ("apisfreellm", "free-ai"),
    "agent-triage": ("grexlabs", "auto:free"),
    "agent-prompt-engineer": ("apisfreellm", "free-ai"),
    "agent-provider-researcher": ("grexlabs", "auto:free"),
    "agent-drift-monitor": ("apisfreellm", "free-ai"),
    "agent-website-currency-agent": ("grexlabs", "auto:free"),
}
path = "/var/lib/teamz-runner/state.json"
state = json.load(open(path))
by = {a["id"]: a for a in state["agents"]}
moved = []
for aid, (prov, model) in MOVES.items():
    a = by.get(aid)
    if not a:
        print("MISSING:", aid)
        continue
    old = (a.get("provider"), a.get("model"))
    a["provider"] = prov
    a["model"] = model
    moved.append((aid, old, (prov, model)))
    print(aid, old, "->", (prov, model))
json.dump(state, open(path, "w"), indent=2)
print("patched", len(moved), "agents in", path)
