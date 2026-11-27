import json
import urllib.request

# Live PING health for the three candidate providers. One tiny /chat each;
# a real short reply = healthy, an error/429/credits text = not.
URL = "http://127.0.0.1:8897/chat"
CANDIDATES = [
    ("grexlabs", "auto:free"),
    ("apisfreellm", "free-ai"),
    ("blockrun-free", "nvidia/nemotron-3.5-lightning"),
]
for provider, model in CANDIDATES:
    body = json.dumps({
        "agent": {"id": "agent-health-probe", "name": "Health Probe", "provider": provider,
                  "model": model, "systemPrompt": "You are a health probe. Reply with exactly: PING OK"},
        "messages": [{"role": "user", "content": "Reply with exactly: PING OK"}],
        "channel": {"id": "conv-build-room", "name": "Build Room", "members": []},
    }).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
        reply = data.get("reply", data.get("error", ""))
        print(provider, "->", reply[:120].replace("\n", " "), flush=True)
    except Exception as e:
        print(provider, "-> HTTP-ERR:", str(e)[:120], flush=True)
