#!/usr/bin/env python3
"""Teamz capacity meter — Jesse's equation.

  x = providers' RPM, aggregated (total requests/min across providers)
  y = number of providers
  z = number of agents

Known operating point: z=34 agents run on y=4 providers.
Find x (aggregated RPM), then scale z by x to get the max agents.

  max_agents = z_now * (x_new / x_old)

The RPM table is per-provider requests/minute. 'source' says where the
number came from; ESTIMATE means a conservative guess, not a published
limit. OVH is rescue-only reserve — counted in x but flagged, since
Jesse keeps it for rescues, not regular work.

Usage:
  python3 scripts/capacity-meter.py [providers.json] [state.json]
Defaults read the live files fetched from jnet1 into /tmp.
"""
import json
import sys

# ---------------------------------------------------------------------------
# RPM table: requests/minute per provider.
# ---------------------------------------------------------------------------
RPM = {
    # Keyed Pollinations. Anonymous was ~1 reply/45s (~1.3 RPM); keyed is
    # higher. 10 RPM is a conservative estimate.
    "pollinations": {"rpm": 10, "source": "ESTIMATE (keyed; anonymous ~1.3 RPM)"},
    # Kilo Gateway free models: 200 requests/hour per IP = 3.33 RPM.
    "kilo": {"rpm": 200 / 60, "source": "free-llm.com (200/hr/IP)"},
    # Free.ai: small fragile tier.
    "freeai": {"rpm": 5, "source": "ESTIMATE (conservative; fragile)"},
    # APIsFreeLLM: low-trust operator, low-stakes only.
    "apisfreellm": {"rpm": 5, "source": "ESTIMATE (conservative; low-trust)"},
    # OVH anonymous lane: 2 req/min. RESCUE-ONLY by Jesse's decision.
    "ovh": {"rpm": 2, "source": "free-llm.com (2/min/IP)", "rescue_only": True},
    # Google AI Studio (Gemini) free tier: 5-30 RPM by model.
    "gemini": {"rpm": 15, "source": "ESTIMATE (free tier; 5-30 RPM by model)"},
    # Groq free tier: 30 RPM.
    "groq": {"rpm": 30, "source": "free-llm.com (30 RPM)"},
}

# The original 4 providers (before OVH/Gemini/Groq were added).
ORIGINAL = ["pollinations", "kilo", "freeai", "apisfreellm"]


def main():
    providers_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/providers-live.json"
    state_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/state-live.json"
    reg = json.load(open(providers_path))
    state = json.load(open(state_path))

    providers = [p["id"] for p in reg["providers"]]
    # Providers with keys given but not yet in the registry still count
    # toward the new total — they are being wired in now.
    pending = [pid for pid in ("gemini", "groq") if pid not in providers and pid in RPM]
    all_providers = sorted(set(providers) | set(pending))

    z_now = len(state["agents"])
    y_old = len(ORIGINAL)
    y_new = len(all_providers)

    def agg(pids):
        return sum(RPM[pid]["rpm"] for pid in pids if pid in RPM)

    x_old = agg(ORIGINAL)
    x_new = agg(all_providers)
    x_new_regular = agg([p for p in all_providers if not RPM.get(p, {}).get("rescue_only")])

    # Scale z by x (the equation): max = z_now * (x_new / x_old).
    max_by_rpm = z_now * (x_new / x_old) if x_old else 0
    max_by_rpm_regular = z_now * (x_new_regular / x_old) if x_old else 0
    # Naive count scaling (assumes every provider is the same speed).
    max_by_count = z_now * (y_new / y_old) if y_old else 0

    print("=== Teamz capacity meter (x = aggregated RPM) ===")
    print(f"Known point: z={z_now} agents on y={y_old} providers {ORIGINAL}")
    print(f"x (aggregated RPM), original {y_old}: {x_old:.1f} RPM")
    print()
    print("Per-provider RPM:")
    for pid in all_providers:
        info = RPM.get(pid, {})
        tag = " (pending)" if pid in pending else ""
        tag += " [rescue-only]" if info.get("rescue_only") else ""
        print(f"  {pid:<12} {info.get('rpm', 0):>6.2f} RPM  — {info.get('source', 'unknown')}{tag}")
    print()
    print(f"y (providers now): {y_new} {sorted(all_providers)}")
    print(f"x (aggregated RPM), all {y_new}: {x_new:.1f} RPM")
    print(f"x (aggregated RPM), regular only (no OVH): {x_new_regular:.1f} RPM")
    print()
    print(f"MAX AGENTS by RPM scaling  z * (x_new / x_old) = {z_now} * ({x_new:.1f}/{x_old:.1f}): {max_by_rpm:.0f}")
    print(f"MAX AGENTS by RPM scaling (regular only, no OVH): {max_by_rpm_regular:.0f}")
    print(f"MAX AGENTS by count scaling  z * (y_new / y_old) = {z_now} * ({y_new}/{y_old}): {max_by_count:.0f}")
    print()
    print("Read it as: ~100 agents is the RPM-based max (the new providers")
    print("are faster than the old ones, so RPM scaling beats count scaling).")
    print("The count scaling (~60) is the floor if every provider were as")
    print("slow as the original four. OVH is rescue-only reserve.")
    print()
    print("Notes: RPM figures marked ESTIMATE are conservative guesses, not")
    print("published caps. Daily caps (Groq 1000/day, Kilo 4800/day) can bind")
    print("before RPM does on a heavy day — re-run this meter if a provider")
    print("publishes a real limit or a key changes its tier.")


if __name__ == "__main__":
    main()
