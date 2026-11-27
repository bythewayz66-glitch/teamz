#!/usr/bin/env python3
"""Create LIVE Stripe Prices for the mem20 shop's a-la-carte SKUs.

Governed price-creation helper for the Teamz runner, mirroring the
push-mem20.py pattern: root-owned, run via sudo (teamz), because it reads
the Stripe secret key from /opt/mem20/secrets/.env.

Flow:
  1. Read the approved price table from the design stage output of the job
     (state.json -> job -> latest ok 'design' run -> first ```json block).
  2. Read the live catalog (/opt/mem20/.../catalog.json) and only price
     SKUs that are still unpriced there (empty price_id).
  3. Validate EVERY entry before creating anything. Any validation
     failure aborts with no prices created.
  4. For each SKU: reuse an existing Stripe Price that carries
     metadata.sku == sku and the same amount (no duplicates); otherwise
     create one (inline product_data, metadata.sku set, idempotency key
     per SKU).
  5. Print a JSON summary mapping sku -> price_id.

Safety:
  - Only the 15 known a-la-carte SKU ids are ever priced. The four tier
    SKUs are never touched.
  - The design table is untrusted input: validated, never executed.
  - A proposed kind must match the catalog kind for that SKU.
  - If an existing Price for a SKU has a DIFFERENT amount than proposed,
    refuse loudly instead of silently reusing the wrong price.
  - The secret key is read from /opt/mem20/secrets/.env and never printed.
  - Amounts are sanity-banded: $1 .. $100,000. Outside that, refuse.

Usage: create-stripe-prices.py <job-id>
Exit 0: prices created/reused, JSON summary printed.
Exit non-zero: nothing was created (validation) or a partial failure is
reported with which SKUs succeeded (idempotent re-run is safe).
"""

from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

STATE_PATH = Path("/var/lib/teamz-runner/state.json")
CATALOG_PATH = Path("/opt/mem20/mem20shopz/mem20shopz/catalog.json")
SECRETS_PATH = Path("/opt/mem20/secrets/.env")
STRIPE_API = "https://api.stripe.com/v1"

# The fifteen a-la-carte SKUs, with the kind the catalog assigns each.
# Tier SKUs (team/business/scale/enterprise) are deliberately absent.
KNOWN_SKUS = {
    "foundation-single": "one_time",
    "fleet-starter": "one_time",
    "hosting-monthly": "subscription",
    "ops-audit": "one_time",
    "control-plane-setup": "one_time",
    "oncall-monthly": "subscription",
    "memory-tiering": "one_time",
    "agent-fleet-build": "one_time",
    "intelligence-monthly": "subscription",
    "asset-pipeline": "one_time",
    "game-vertical": "one_time",
    "studio-monthly": "subscription",
    "migration": "one_time",
    "training": "one_time",
    "priority-support-monthly": "subscription",
}

MIN_CENTS = 100            # $1
MAX_CENTS = 10_000_000     # $100,000


def fail(msg: str) -> "SystemExit":
    print(f"create-stripe-prices: ERROR: {msg}", file=sys.stderr)
    return SystemExit(1)


def load_design_table(job_id: str) -> list[dict]:
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception as err:
        raise RuntimeError(f"cannot read runner state {STATE_PATH}: {err}")
    job = next((j for j in state.get("jobs", []) if j.get("id") == job_id), None)
    if job is None:
        raise RuntimeError(f"unknown job {job_id!r} in runner state")
    design = None
    for run in reversed(job.get("runs", [])):
        if run.get("stage") == "design" and run.get("status") == "ok" and run.get("output"):
            design = run["output"]
            break
    if not design:
        raise RuntimeError(f"job {job_id!r} has no completed ok 'design' run to price from")
    m = re.search(r"```json\s*(\[.*?\])\s*```", design, re.DOTALL)
    if not m:
        raise RuntimeError("design output has no ```json [...]``` price table block")
    try:
        table = json.loads(m.group(1))
    except json.JSONDecodeError as err:
        raise RuntimeError(f"design price table is not valid JSON: {err}")
    if not isinstance(table, list) or not table:
        raise RuntimeError("design price table must be a non-empty JSON array")
    return table


def load_unpriced_catalog_skus() -> dict[str, dict]:
    try:
        catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except Exception as err:
        raise RuntimeError(f"cannot read catalog {CATALOG_PATH}: {err}")
    out = {}
    for sku in catalog.get("skus", []):
        if sku.get("id") in KNOWN_SKUS and not sku.get("price_id"):
            out[sku["id"]] = sku
    return out


def load_secret_key() -> str:
    try:
        text = SECRETS_PATH.read_text(encoding="utf-8")
    except Exception as err:
        raise RuntimeError(f"cannot read secrets file {SECRETS_PATH}: {err}")
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("STRIPE_SECRET_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
            if key.startswith("sk_live_"):
                return key
            raise RuntimeError("STRIPE_SECRET_KEY in secrets file is not a live key")
    raise RuntimeError("STRIPE_SECRET_KEY not found in secrets file")


class Stripe:
    def __init__(self, key: str):
        self.key = key

    def _req(self, method: str, path: str, data: dict | None = None,
             idem: str | None = None) -> dict:
        url = STRIPE_API + path
        body = urllib.parse.urlencode(data or {}).encode() if data is not None else None
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", f"Bearer {self.key}")
        if body is not None:
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
        if idem:
            req.add_header("Idempotency-Key", idem)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:500]
            raise RuntimeError(f"Stripe {method} {path} -> HTTP {err.code}: {detail}")

    def list_prices(self) -> list[dict]:
        out: list[dict] = []
        url = "/v1/prices?limit=100"
        while url:
            page = self._req("GET", url)
            out.extend(page.get("data", []))
            url = page.get("next_page_url")
            if url:
                url = url.replace(STRIPE_API, "")
        return out

    def create_price(self, sku: str, name: str, amount_cents: int, kind: str) -> dict:
        data = {
            "currency": "usd",
            "unit_amount": str(amount_cents),
            "product_data[name]": name,
            "product_data[metadata][sku]": sku,
            "metadata[sku]": sku,
        }
        if kind == "subscription":
            data["recurring[interval]"] = "month"
        return self._req("POST", "/v1/prices", data, idem=f"shop-alacarte-{sku}-v1")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: create-stripe-prices.py <job-id>", file=sys.stderr)
        return 2
    job_id = argv[1]
    try:
        table = load_design_table(job_id)
        unpriced = load_unpriced_catalog_skus()
        secret = load_secret_key()
    except RuntimeError as err:
        print(f"create-stripe-prices: ERROR: {err}", file=sys.stderr)
        return 1

    # ---- Validate everything before creating anything. ----
    seen: set[str] = set()
    plan: list[dict] = []
    for entry in table:
        if not isinstance(entry, dict):
            print("create-stripe-prices: ERROR: price table entry is not an object", file=sys.stderr)
            return 1
        sku = entry.get("sku")
        amount = entry.get("amount_cents")
        kind = entry.get("kind")
        if sku in seen:
            print(f"create-stripe-prices: ERROR: duplicate sku {sku!r} in price table", file=sys.stderr)
            return 1
        seen.add(sku)
        if sku not in KNOWN_SKUS:
            print(f"create-stripe-prices: ERROR: sku {sku!r} is not one of the 15 a-la-carte SKUs — refusing", file=sys.stderr)
            return 1
        if kind != KNOWN_SKUS[sku]:
            print(f"create-stripe-prices: ERROR: sku {sku!r} kind {kind!r} != catalog kind {KNOWN_SKUS[sku]!r} — refusing", file=sys.stderr)
            return 1
        if not isinstance(amount, int) or isinstance(amount, bool) or not (MIN_CENTS <= amount <= MAX_CENTS):
            print(f"create-stripe-prices: ERROR: sku {sku!r} amount_cents {amount!r} outside ${MIN_CENTS//100}..${MAX_CENTS//100} — refusing", file=sys.stderr)
            return 1
        if sku not in unpriced:
            continue  # already priced in the catalog; nothing to create
        plan.append({"sku": sku, "name": unpriced[sku]["name"],
                     "amount_cents": amount, "kind": kind})
    if not plan:
        print(json.dumps({"created": {}, "reused": {}, "skipped_already_priced": sorted(seen),
                          "note": "no unpriced a-la-carte SKUs in the approved table"}))
        return 0

    # ---- Create (or reuse) the Stripe Prices. ----
    stripe = Stripe(secret)
    try:
        existing = stripe.list_prices()
    except RuntimeError as err:
        print(f"create-stripe-prices: ERROR: {err}", file=sys.stderr)
        return 1
    by_sku: dict[str, dict] = {}
    for p in existing:
        md = p.get("metadata") or {}
        if md.get("sku") in KNOWN_SKUS and md.get("sku") not in by_sku:
            by_sku[md["sku"]] = p

    created: dict[str, str] = {}
    reused: dict[str, str] = {}
    for item in plan:
        sku = item["sku"]
        prior = by_sku.get(sku)
        if prior is not None:
            if prior.get("unit_amount") != item["amount_cents"]:
                print(f"create-stripe-prices: ERROR: sku {sku!r} already has Stripe Price "
                      f"{prior.get('id')} for {prior.get('unit_amount')} cents, but the approved "
                      f"amount is {item['amount_cents']} cents — refusing to create a conflicting price",
                      file=sys.stderr)
                return 1
            reused[sku] = prior["id"]
            continue
        try:
            price = stripe.create_price(sku, item["name"], item["amount_cents"], item["kind"])
        except RuntimeError as err:
            print(f"create-stripe-prices: ERROR: {err}", file=sys.stderr)
            print(f"create-stripe-prices: partial progress — created so far: {json.dumps(created)}; "
                  f"reused so far: {json.dumps(reused)}", file=sys.stderr)
            return 1
        created[sku] = price["id"]

    print(json.dumps({"created": created, "reused": reused,
                      "skipped_already_priced": sorted(seen - {i['sku'] for i in plan})}, indent=1))
    for sku, pid in {**created, **reused}.items():
        print(f"  {sku}: {pid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
