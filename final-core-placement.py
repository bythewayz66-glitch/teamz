import json

# Final core-agent placement (Nov 27, 2026 ~22:17Z). blockrun (gpt-oss-120b)
# 429s immediately under fleet load ("Free model capacity exhausted") —
# it is not a reliable home despite answering a lone PING. The reasoning
# roles go back to blockrun-free (nemotron), the best of the weak-but-
# answering providers: it proved it can verify-and-approve as Reviewer,
# and as Triage it lists issues and verifies (it only fails to finish).
# Prompt Engineer + Orchestrator stay on apisfreellm (constrained tasks
# it handles; the gate falls back to the draft if PE rambles).
# Drift Monitor + WCA stay on grexlabs (mechanical roles).
MOVES = {
    "agent-reviewer": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-triage": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-provider-researcher": ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
    "agent-prompt-engineer": ("apisfreellm", "free-ai"),
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
print("final placement written")
