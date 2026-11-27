import json

src = json.load(open("/var/lib/teamz-runner/state.json"))
job = [j for j in src["jobs"] if j["id"] == "job-homepage-cartoon-card"][0]
test = {
    "version": 1,
    "agents": src["agents"],
    "jobs": [job],
    "triggers": [],
    "approvals": [a for a in src["approvals"] if a["jobId"] == "job-homepage-cartoon-card"],
    "cronJobs": [],
    "channelMessages": [],
    "rateLimitRescues": [],
    "rateLimitBackoff": {},
    "strandedSweeps": {},
    "triageRecovery": {},
}
json.dump(test, open("/tmp/test-state2.json", "w"), indent=2)
print("test state2 written: job", job["id"], "status", job["status"],
      "approvals", len(test["approvals"]), "agents", len(test["agents"]))
