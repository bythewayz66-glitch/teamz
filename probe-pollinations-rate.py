import json
import time
import urllib.request

# 5 quick probes to the Reviewer on pollinations: count real replies vs
# "not enough credits" error replies.
URL = "http://127.0.0.1:8897/chat"
state = json.load(open("/var/lib/teamz-runner/state.json"))
reviewer = next(a for a in state["agents"] if a["id"] == "agent-reviewer")
print("reviewer provider:", reviewer.get("provider"), "model:", reviewer.get("model"), flush=True)

results = []
for i in range(5):
    body = json.dumps({
        "agent": {
            "id": reviewer["id"],
            "name": reviewer["name"],
            "model": reviewer.get("model") or "openai",
            "systemPrompt": reviewer.get("systemPrompt") or "",
        },
        "messages": [{"role": "user", "content": "REVIEW REQUEST — reply with exactly this one line and nothing else: APPROVE: probe ok."}],
        "channel": {"id": "conv-build-room", "name": "Build Room", "members": []},
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
        reply = data.get("reply", "")
        if "APPROVE: probe ok" in reply:
            results.append("OK")
        elif "not enough credits" in reply:
            results.append("CREDITS-ERR")
        else:
            results.append("OTHER: " + reply[:80])
    except Exception as e:
        results.append("HTTP-ERR: " + str(e)[:80])
    print(i, results[-1], flush=True)
    time.sleep(10)
print("summary:", results)
