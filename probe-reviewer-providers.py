import json
import urllib.request

# Test the Reviewer on apisfreellm and blockrun-free with the same
# repo-verification probe. grexlabs just failed it (created a junk cron
# instead of verifying), so the Reviewer needs a better home.
URL = "http://127.0.0.1:8897/chat"
state = json.load(open("/var/lib/teamz-runner/state.json"))
reviewer = next(a for a in state["agents"] if a["id"] == "agent-reviewer")
PROMPT = (
    "VERIFICATION PROBE — use your repo_read tool before you answer. "
    "Claim to check: the file docs/series/cartoon/index.html exists in the mem20 repo. "
    "Read it with repo_read and report exactly what you found (first line of the file), "
    "then give your one-line verdict: APPROVE or DENY on whether a homepage card may link to series/cartoon/."
)
for provider, model in [("apisfreellm", "free-ai"), ("blockrun-free", "nvidia/nemotron-3.5-lightning")]:
    body = json.dumps({
        "agent": {"id": reviewer["id"], "name": reviewer["name"], "model": model,
                  "systemPrompt": reviewer.get("systemPrompt") or ""},
        "messages": [{"role": "user", "content": PROMPT}],
        "channel": {"id": "conv-build-room", "name": "Build Room", "members": []},
    }).encode()
    # NOTE: the agent object has no provider field here on purpose — the
    # endpoint defaults to pollinations. Set provider explicitly instead.
    body = json.dumps({
        "agent": {"id": reviewer["id"], "name": reviewer["name"], "provider": provider,
                  "model": model, "systemPrompt": reviewer.get("systemPrompt") or ""},
        "messages": [{"role": "user", "content": PROMPT}],
        "channel": {"id": "conv-build-room", "name": "Build Room", "members": []},
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode())
        print(provider, "->", json.dumps(data)[:800], flush=True)
    except Exception as e:
        print(provider, "-> HTTP-ERR:", str(e)[:200], flush=True)
