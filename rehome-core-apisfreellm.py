import json

# Re-home the reasoning-heavy core agents off blockrun-free (Nov 27, 2026
# ~21:40Z: "Free model capacity exhausted" 429 on the Triage probe) onto
# apisfreellm — the only provider that passed the Reviewer verification
# probe cleanly AND stayed up. Drift Monitor (mechanical comparison role)
# goes to grexlabs, which proved fine for fetch-and-report work.
MOVES = {
    "agent-triage": ("apisfreellm", "free-ai"),
    "agent-provider-researcher": ("apisfreellm", "free-ai"),
    "agent-drift-monitor": ("grexlabs", "auto:free"),
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
