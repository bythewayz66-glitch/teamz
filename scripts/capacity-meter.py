#!/usr/bin/env python3
"""Teamz capacity meter — theoretical max agents from provider rate limits.

Reads the live provider registry + runner state, applies a rate-limit
table (sourced where known, flagged where estimated), and computes:
  * scheduled dispatches/day (from cron schedules)
  * upstream requests/day (dispatches x calls-per-dispatch)
  * per-provider load and headroom
  * theoretical max agents (hourly-schedule agents) before limits bind

Usage:
  python3 scripts/capacity-meter.py [providers.json] [state.json]
Defaults read the live files fetched from jnet1 into /tmp.

Rate-limit table — 'source' says where the number came from; anything
marked ESTIMATE is a conservative guess, not a published limit. Update
the table when a provider publishes (or a key changes) its real limit.
"""
import json
import sys
from collections import Counter, defaultdict

# ---------------------------------------------------------------------------
# Rate limits: max upstream requests per day per provider.
# 'daily' is the binding daily allowance. 'rpm' is the per-minute rate
# (used for the burst check). 'rescue_only' providers are reserve only.
# ---------------------------------------------------------------------------
LIMITS = {
    # Keyed Pollinations. No published daily cap for the keyed tier;
    # 100/day was the ANONYMOUS cap. 1000/day is a conservative estimate.
    "pollinations": {"daily": 1000, "rpm": 60, "source": "ESTIMATE (keyed; anonymous cap was 100/day)"},
    # Kilo Gateway free models: 200 requests/hour per IP.
    "kilo": {"daily": 4800, "rpm": 200 / 60, "source": "free-llm.com (200/hr/IP)"},
    # Free.ai: small fragile tier; backed off after 6 failures Nov 26.
    "freeai": {"daily": 200, "rpm": 5, "source": "ESTIMATE (conservative; fragile)"},
    # APIsFreeLLM: low-trust operator, low-stakes only.
    "apisfreellm": {"daily": 200, "rpm": 5, "source": "ESTIMATE (conservative; low-trust)"},
    # OVH anonymous lane: 2 req/min. RESCUE-ONLY by Jesse's decision.
    "ovh": {"daily": 2880, "rpm": 2, "source": "free-llm.com (2/min/IP)", "rescue_only": True},
    # Google AI Studio (Gemini) free tier. RPM 5-30 by model (free-llm.com);
    # daily is a conservative estimate — Google does not publish one number.
    "gemini": {"daily": 2000, "rpm": 15, "source": "ESTIMATE (free tier; RPM 5-30 by model)"},
    # Groq free tier: 30 RPM, 1000 requests/day (GPT-OSS / Qwen models).
    "groq": {"daily": 1000, "rpm": 30, "source": "free-llm.com (30 RPM, 1000/day)"},
}

# Upstream calls per dispatch (tool-loop rounds). A simple hourly job is
# usually 1-2 calls; complex work is more. 3 is the conservative average.
CALLS_PER_DISPATCH = 3
# Optimistic bound, for the range.
CALLS_PER_DISPATCH_OPTIMISTIC = 2


def cron_runs_per_day(schedule):
    """Runs/day for a cron expression. Handles the schedules we use."""
    if not schedule:
        return 0
    parts = schedule.split()
    if len(parts) != 5:
        return 0
    minute, hour = parts[0], parts[1]
    if minute == "0" and hour == "*":
        return 24  # hourly
    if minute == "*/15" and hour == "*":
        return 96  # every 15 min
    if minute == "0" and hour.startswith("*/"):
        try:
            return 24 // int(hour[2:])
        except ValueError:
            return 0
    if minute == "0" and hour.isdigit():
        return 1  # once daily
    return 0


def main():
    providers_path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/providers-live.json"
    state_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/state-live.json"
    reg = json.load(open(providers_path))
    state = json.load(open(state_path))

    providers = {p["id"]: p for p in reg["providers"]}
    agents = state["agents"]
    cron_jobs = state.get("cronJobs", [])

    # --- demand: scheduled dispatches/day ---------------------------------
    dispatches_per_day = sum(cron_runs_per_day(c.get("schedule") or c.get("cron")) for c in cron_jobs)
    # Product jobs (nightly repo check etc.) run ~1/day each; small, include.
    dispatches_per_day += len(state.get("jobs", [])) * 1
    upstream_per_day = dispatches_per_day * CALLS_PER_DISPATCH
    upstream_per_day_opt = dispatches_per_day * CALLS_PER_DISPATCH_OPTIMISTIC

    # Per-agent usage: an hourly-schedule agent costs 24 dispatches/day.
    per_hourly_agent_upstream = 24 * CALLS_PER_DISPATCH
    per_hourly_agent_upstream_opt = 24 * CALLS_PER_DISPATCH_OPTIMISTIC

    # --- supply: daily capacity -------------------------------------------
    regular = {pid: LIMITS[pid] for pid in providers if pid in LIMITS and not LIMITS[pid].get("rescue_only")}
    reserve = {pid: LIMITS[pid] for pid in providers if pid in LIMITS and LIMITS[pid].get("rescue_only")}
    # Providers that will exist once keys validate (not in registry yet).
    pending = {pid: LIMITS[pid] for pid in ("gemini", "groq") if pid not in providers and pid in LIMITS}

    total_daily = sum(v["daily"] for v in regular.values()) + sum(v["daily"] for v in pending.values())
    reserve_daily = sum(v["daily"] for v in reserve.values())

    # --- per-provider load (current assignments) --------------------------
    spread = Counter(a.get("provider") or "pollinations" for a in agents)
    # Hourly agents per provider (the 26 hourly cron jobs map to agents).
    hourly_agent_ids = {c.get("agentId") for c in cron_jobs if (c.get("schedule") or c.get("cron")) == "0 * * * *"}
    agent_by_id = {a["id"]: a for a in agents}
    hourly_per_provider = Counter()
    for aid in hourly_agent_ids:
        ag = agent_by_id.get(aid)
        if ag:
            hourly_per_provider[ag.get("provider") or "pollinations"] += 1
    # Orchestrator (15-min) + researcher/keymaster are small; fold into total.
    load_per_provider = {}
    for pid in set(list(spread) + list(regular) + list(pending)):
        hourly_n = hourly_per_provider.get(pid, 0)
        # Each hourly agent: 24 dispatches/day x calls. Plus a share of the
        # orchestrator/researcher/keymaster load, split evenly (small).
        extra = (96 + 4 + 1) * CALLS_PER_DISPATCH / max(len(regular) + len(pending), 1)
        load_per_provider[pid] = hourly_n * per_hourly_agent_upstream + extra

    # --- max agents --------------------------------------------------------
    headroom = total_daily - upstream_per_day
    headroom_opt = total_daily - upstream_per_day_opt
    max_agents = len(agents) + max(0, int(headroom // per_hourly_agent_upstream))
    max_agents_opt = len(agents) + max(0, int(headroom_opt // per_hourly_agent_upstream_opt))

    # Burst check: hourly batch (26 agents) drains over ~22 min (50s gap).
    burst_upstream_per_min = (len(hourly_agent_ids) * CALLS_PER_DISPATCH) / 22
    slowest_rpm = min(v["rpm"] for v in regular.values()) if regular else 0

    print("=== Teamz capacity meter ===")
    print(f"Providers in registry: {len(providers)} ({', '.join(sorted(providers))})")
    if pending:
        print(f"Pending (keys given, not yet in registry): {', '.join(sorted(pending))}")
    if reserve:
        print(f"Reserve (rescue-only, not counted in regular capacity): {', '.join(sorted(reserve))} ({reserve_daily:,}/day)")
    print(f"Agents now: {len(agents)} | cron jobs: {len(cron_jobs)}")
    print()
    print(f"Scheduled dispatches/day: {dispatches_per_day:,}")
    print(f"Upstream requests/day (x{CALLS_PER_DISPATCH} calls/dispatch): {upstream_per_day:,}")
    print(f"Total regular daily capacity: {total_daily:,}")
    print(f"Current utilisation: {upstream_per_day / total_daily * 100:.0f}%")
    print()
    print("Per-provider (daily cap / est. load / headroom):")
    for pid in sorted(set(list(regular) + list(pending) + list(load_per_provider))):
        cap = (regular.get(pid) or pending.get(pid) or {}).get("daily", 0)
        load = load_per_provider.get(pid, 0)
        tag = " (pending)" if pid in pending else ""
        print(f"  {pid:<12} {cap:>6,}/day  load ~{load:>6,.0f}  headroom ~{cap - load:>6,.0f}{tag}")
    print()
    print(f"Headroom: {headroom:,.0f} upstream requests/day")
    print(f"Cost of one more hourly agent: {per_hourly_agent_upstream} upstream/day")
    print(f"THEORETICAL MAX AGENTS (conservative, x{CALLS_PER_DISPATCH} calls/dispatch): {max_agents}")
    print(f"THEORETICAL MAX AGENTS (optimistic, x{CALLS_PER_DISPATCH_OPTIMISTIC} calls/dispatch): {max_agents_opt}")
    print()
    print(f"Burst check: hourly batch ~{burst_upstream_per_min:.1f} upstream/min at peak; "
          f"slowest regular provider allows ~{slowest_rpm:.1f}/min — "
          f"{'OK, spread across providers' if burst_upstream_per_min < slowest_rpm * len(regular) else 'WATCH: batch could crowd the slowest provider'}")
    print()
    print("Notes: limits marked ESTIMATE are conservative guesses, not published")
    print("caps — the meter is a planning guide, not a guarantee. OVH is")
    print("rescue-only reserve and is NOT counted in regular capacity.")


if __name__ == "__main__":
    main()
