#!/usr/bin/env python3
"""Teamz capacity meter — BOTH equations, compared every run.

Model A — Jesse's equation (RPM scaling):
  x = providers' RPM, aggregated (total requests/min across providers)
  y = number of providers
  z = number of agents
  Known point: z=34 agents on y=4 providers.
  max_agents = z_now * (x_new / x_old)

Model B — Daily-capacity equation:
  total daily capacity (upstream requests/day across providers)
  divided by per-agent daily usage (dispatches/day x calls/dispatch).
  max_agents = total_daily_capacity / per_hourly_agent_daily_usage
  (plus the agents already running).

Both models are computed from the same live registry + runner state and
printed side by side, so they cross-check each other. When they agree,
the number is solid; when they diverge, the lower one is the binding
constraint and the notes say why.

Usage:
  python3 scripts/capacity-meter.py [providers.json] [state.json]
Defaults read the live files fetched from jnet1 into /tmp.

Rate tables — 'source' says where the number came from; ESTIMATE is a
conservative guess, not a published limit. OVH is rescue-only reserve:
counted in Model A (it is a provider) but NOT in Model B's regular
capacity. Update the tables when a provider publishes a real limit or
a key changes its tier.
"""
import json
import sys
from collections import Counter

# ---------------------------------------------------------------------------
# Per-provider limits. rpm = requests/minute (Model A).
# daily = max upstream requests/day (Model B).
# ---------------------------------------------------------------------------
LIMITS = {
    # Keyed Pollinations. Anonymous was ~1 reply/45s (~1.3 RPM) and
    # 100/day; the service is KEYED now (upstream: gen.pollinations.ai).
    # OBSERVED Nov 27, 2026: 1,245 calls by ~13:16 MST, no 429s.
    "pollinations": {"rpm": 10, "daily": 2000,
                     "source": "OBSERVED Nov 27 (1,245 calls, no 429s; keyed)"},
    # Kilo Gateway: DEAD for the tool loop. OBSERVED Nov 27, 2026: the
    # endpoint answers 200 but with EMPTY content (model reflection /
    # beam-free returns reasoning only, no content), and it 429'd on
    # PROMOTION_MODEL_LIMIT_REACHED while judging. Do not assign agents.
    "kilo": {"rpm": 0, "daily": 0,
             "source": "OBSERVED Nov 27 (200 but empty content — dead)"},
    # Free.ai: dead. Backed off after 6 failures Nov 26; no agents.
    "freeai": {"rpm": 0, "daily": 0,
               "source": "OBSERVED Nov 26-27 (dead, 6 failures)"},
    # APIsFreeLLM: low-trust operator, low-stakes only.
    # OBSERVED Nov 27: 304 calls, no 429s.
    "apisfreellm": {"rpm": 5, "daily": 300,
                    "source": "OBSERVED Nov 27 (304 calls, no 429s)"},
    # OVH anonymous lane: 2 req/min. RESCUE-ONLY by Jesse's decision.
    # OBSERVED Nov 27: 429 (quota-exhausted even for rescue).
    "ovh": {"rpm": 2, "daily": 2880,
            "source": "free-llm.com (2/min/IP); OBSERVED Nov 27: 429", "rescue_only": True},
    # Google AI Studio (Gemini) free tier: 5-30 RPM by model.
    # OBSERVED Nov 27: 429 quota-exceeded after ~717 calls — the daily
    # quota, not RPM, is the binding limit. Triage died on it ~16x.
    "gemini": {"rpm": 15, "daily": 750,
               "source": "OBSERVED Nov 27 (429 after ~717 calls)"},
    # Groq free tier: 30 RPM. The binding limit is TOKENS, not requests:
    # 200k TPD, ~2,600 tokens per dispatch ≈ 77 dispatches/day ≈ 230
    # calls/day. OBSERVED Nov 27: 429 "TPD Limit 200000, Used 198336".
    "groq": {"rpm": 30, "daily": 230,
             "source": "OBSERVED Nov 27 (200k TPD ≈ 77 dispatches/day)"},
    # BlockRun (gpt-oss-120b): OBSERVED Nov 27: 429. Degraded, not dead.
    "blockrun": {"rpm": 5, "daily": 50,
                 "source": "OBSERVED Nov 27 (429)"},
    # BlockRun-free (nvidia/nemotron-3.5-lightning): OBSERVED Nov 27:
    # 200 PING, healthy. No usage data yet — conservative estimate.
    "blockrun-free": {"rpm": 5, "daily": 200,
                      "source": "OBSERVED Nov 27 (200 PING; ESTIMATE daily)"},
    # GrexLabs (auto:free, Nvidia upstream): OBSERVED Nov 27: 200 PING
    # and 367 calls, no 429s.
    "grexlabs": {"rpm": 5, "daily": 400,
                 "source": "OBSERVED Nov 27 (367 calls, no 429s)"},
    # APIsFreeLLM-new: OBSERVED Nov 27: 200 PING, healthy. No usage
    # data yet — conservative estimate.
    "apisfreellm-new": {"rpm": 5, "daily": 200,
                        "source": "OBSERVED Nov 27 (200 PING; ESTIMATE daily)"},
    # Freekey: OBSERVED Nov 27: 403 — dead. Do not assign agents.
    "freekey": {"rpm": 0, "daily": 0,
                "source": "OBSERVED Nov 27 (403 — dead)"},
}

# The original 4 providers (before OVH/Gemini/Groq were added).
ORIGINAL = ["pollinations", "kilo", "freeai", "apisfreellm"]

# FIXED known operating point for Model A: z=34 agents ran on y=4
# providers. This baseline NEVER moves — Model A scales from it, not from
# the current agent count (using the current count would double-count
# every expansion). max_a = KNOWN_Z * (x_new / x_old).
KNOWN_Z = 34

# Upstream calls per dispatch (tool-loop rounds). A simple hourly job is
# usually 1-2 calls; complex work is more. 3 = conservative, 2 = optimistic.
CALLS_PER_DISPATCH = 3
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

    providers = [p["id"] for p in reg["providers"]]
    pending = [pid for pid in ("gemini", "groq") if pid not in providers and pid in LIMITS]
    all_providers = sorted(set(providers) | set(pending))
    regular = [p for p in all_providers if not LIMITS.get(p, {}).get("rescue_only")]

    z_now = len(state["agents"])
    y_old = len(ORIGINAL)
    y_new = len(all_providers)

    # ================= Model A: RPM scaling (Jesse) ========================
    def agg_rpm(pids):
        return sum(LIMITS[pid]["rpm"] for pid in pids if pid in LIMITS)

    x_old = agg_rpm(ORIGINAL)
    x_new = agg_rpm(all_providers)
    x_new_regular = agg_rpm(regular)
    # Model A scales from the FIXED known point (KNOWN_Z on ORIGINAL),
    # not from the current agent count.
    max_a = KNOWN_Z * (x_new / x_old) if x_old else 0
    max_a_regular = KNOWN_Z * (x_new_regular / x_old) if x_old else 0
    max_a_count = KNOWN_Z * (y_new / y_old) if y_old else 0

    # ================= Model B: daily capacity =============================
    cron_jobs = state.get("cronJobs", [])
    dispatches_per_day = sum(
        cron_runs_per_day(c.get("schedule") or c.get("cron")) for c in cron_jobs
    )
    dispatches_per_day += len(state.get("jobs", [])) * 1  # product jobs ~1/day
    upstream_per_day = dispatches_per_day * CALLS_PER_DISPATCH
    upstream_per_day_opt = dispatches_per_day * CALLS_PER_DISPATCH_OPTIMISTIC
    total_daily = sum(LIMITS[pid]["daily"] for pid in regular if pid in LIMITS)
    per_hourly_agent = 24 * CALLS_PER_DISPATCH
    per_hourly_agent_opt = 24 * CALLS_PER_DISPATCH_OPTIMISTIC
    headroom = total_daily - upstream_per_day
    headroom_opt = total_daily - upstream_per_day_opt
    max_b = z_now + max(0, int(headroom // per_hourly_agent))
    max_b_opt = z_now + max(0, int(headroom_opt // per_hourly_agent_opt))
    utilisation = upstream_per_day / total_daily * 100 if total_daily else 0

    # Per-provider load (Model B detail): hourly agents per provider.
    hourly_agent_ids = {
        c.get("agentId") for c in cron_jobs
        if (c.get("schedule") or c.get("cron")) == "0 * * * *"
    }
    agent_by_id = {a["id"]: a for a in state["agents"]}
    hourly_per_provider = Counter()
    for aid in hourly_agent_ids:
        ag = agent_by_id.get(aid)
        if ag:
            hourly_per_provider[ag.get("provider") or "pollinations"] += 1

    # ================= Report ==============================================
    print("=== Teamz capacity meter — both equations ===")
    print(f"Providers in registry: {len(providers)} ({', '.join(sorted(providers))})")
    if pending:
        print(f"Pending (keys given, not yet in registry): {', '.join(sorted(pending))}")
    print(f"Agents now: z={z_now} | cron jobs: {len(cron_jobs)} | "
          f"dispatches/day: {dispatches_per_day:,}")
    print()
    print("--- Model A: RPM scaling (Jesse)  x = aggregated RPM ---")
    print(f"Known point (fixed): z={KNOWN_Z} on y={y_old} {ORIGINAL}")
    print(f"Agents now: z={z_now} (baseline stays {KNOWN_Z} — do not rescale from current z)")
    print(f"x_old (original {y_old}): {x_old:.1f} RPM | "
          f"x_new (all {y_new}): {x_new:.1f} RPM | "
          f"x regular (no OVH): {x_new_regular:.1f} RPM")
    print(f"MAX AGENTS (A): z * (x_new / x_old) = {KNOWN_Z} * ({x_new:.1f}/{x_old:.1f}) = {max_a:.0f}")
    print(f"MAX AGENTS (A, regular only): {max_a_regular:.0f}")
    print(f"MAX AGENTS (A, count scaling z * y_new/y_old): {max_a_count:.0f} (floor)")
    print()
    print("--- Model B: daily capacity ---")
    print(f"Upstream/day now: {upstream_per_day:,} (x{CALLS_PER_DISPATCH} calls/dispatch)")
    print(f"Total regular daily capacity: {total_daily:,}")
    print(f"Utilisation: {utilisation:.0f}% | headroom: {headroom:,.0f}/day")
    print(f"Cost of one more hourly agent: {per_hourly_agent} upstream/day")
    print(f"MAX AGENTS (B, conservative x{CALLS_PER_DISPATCH}): {max_b}")
    print(f"MAX AGENTS (B, optimistic x{CALLS_PER_DISPATCH_OPTIMISTIC}): {max_b_opt}")
    print()
    print("Per-provider (Model B): daily cap / est. load / headroom")
    provider_headroom = {}
    for pid in sorted(set(regular) | set(hourly_per_provider)):
        cap = LIMITS.get(pid, {}).get("daily", 0)
        load = hourly_per_provider.get(pid, 0) * per_hourly_agent + (
            (96 + 4 + 1) * CALLS_PER_DISPATCH / max(len(regular), 1)
        )
        provider_headroom[pid] = cap - load
        tag = " (pending)" if pid in pending else ""
        flag = "  <-- OVER est. cap" if load > cap else ""
        print(f"  {pid:<12} {cap:>6,}/day  load ~{load:>6,.0f}  headroom ~{cap - load:>6,.0f}{tag}{flag}")
    print()
    print("--- Comparison ---")
    print(f"Model A (RPM scaling):      ~{max_a:.0f} agents (conservative)")
    print(f"Model B (daily capacity):   ~{max_b} agents (conservative) / ~{max_b_opt} (optimistic, liberal)")
    lo, hi = min(max_a, max_b), max(max_a, max_b_opt)
    print(f"Range across both models:   ~{lo:.0f} – {hi:.0f} agents")
    # Jesse's rule: Model A is conservative, Model B is liberal, so the
    # actual max agents used is halfway between the two sums.
    actual_max = (max_a + max_b) / 2
    print()
    print(f"ACTUAL MAX AGENTS (used):   {(max_a + max_b):.0f} / 2 = {actual_max:.0f}")
    print("  (halfway between Model A and Model B conservative)")
    if max_a < max_b:
        print("Model A is the binding one: per-minute throughput (RPM) binds")
        print("before the daily caps do. New agents should go to the")
        print("highest-RPM providers (Groq, Gemini) to lift it.")
    else:
        print("Model B is the binding one: daily caps bind before RPM does.")
        # Recommend by measured headroom, not a hardcoded list — the old
        # line named Kilo, which is dead now (0/day, empty content).
        top = [pid for pid, hr in sorted(provider_headroom.items(), key=lambda kv: -kv[1]) if hr > 0][:3]
        print("New agents should go to the providers with daily headroom")
        print(f"({', '.join(top) if top else 'none — every provider is at cap'}) — not the small ones.")
    print()
    print("Notes: figures marked ESTIMATE are conservative guesses, not")
    print("published caps. OVH is rescue-only reserve (in Model A, out of")
    print("Model B's regular capacity). Re-run whenever a provider, key,")
    print("or limit changes.")


if __name__ == "__main__":
    main()
