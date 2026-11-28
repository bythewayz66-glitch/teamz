#!/root/.venv/bin/python
"""mem20 toolchest bridge for Teamz agents (jnet1).

Spawns the mem20 MCP server over stdio and speaks JSON-RPC via the MCP
Python SDK. The Teamz agent endpoint (teamz-agent, port 8897) calls this
script — it is the only way Teamz agents reach the mem20 tool catalog.

Subcommands:
    toolchest.py search <query> [domain]
        Search the mem20 tool catalog by keyword and/or domain. Prints one
        JSON object to stdout: {"tools": [...up to 10...], "count": n,
        "total": m}. Each tool: {"name", "domain", "description", "args"}.
        The catalog is cached in /var/lib/teamz-agent/toolchest-catalog.json
        (1h TTL) so a search is fast after the first call; a stale or
        missing cache spawns the MCP server to refresh it.
    toolchest.py call <tool>
        Call one mem20 tool by name. Reads the arguments as one JSON object
        from stdin ({} when empty). Prints the result as JSON to stdout
        ({"tool": name, "result": <text, truncated to 8000 chars>}).
        Exits non-zero with the error on stderr on failure.

Safety: destructive tools are refused before any MCP call — a tool whose
name contains delete/remove/destroy/spend/publish/release/sell/charge/
refund is refused, unless the name also marks it read-only (audit/status/
doctor/list/get/read/search/verify/check), e.g. vcs_asset_release_audit.
No credentials are read, stored, or logged. The MCP server runs locally
over stdio and has no authentication. Never expose it on a network port.

Run with /root/.venv/bin/python so `import mcp` resolves to the SDK in
that venv. The server is spawned as [/root/.venv/bin/python,
/opt/mem20/launcher.py] with cwd /opt/mem20 and PYTHONUNBUFFERED=1,
MEM20_HEALTH_DISABLE=1 — the same spawn the repo's own verify_mcp.py uses.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

VENV_PYTHON = "/root/.venv/bin/python"
REPO_ROOT = "/opt/mem20"
LAUNCHER = "/opt/mem20/launcher.py"
SURFACE = "/opt/mem20/docs/surface.json"
CATALOG_CACHE = "/var/lib/teamz-agent/toolchest-catalog.json"
CACHE_TTL_SECONDS = 3600
MAX_RESULT_CHARS = 8000
MAX_SEARCH_RESULTS = 10
OVERALL_TIMEOUT_SECONDS = 300

DESTRUCTIVE_WORDS = (
    "delete", "remove", "destroy", "spend", "publish",
    "release", "sell", "charge", "refund",
)
READONLY_MARKERS = (
    "audit", "status", "doctor", "list", "get", "read",
    "search", "verify", "check",
)
# Named tools that publish or send to the outside world, beyond the
# word list above: posting to social media, sending email/chat/SMS, and
# committing or opening a PR on GitHub (which would bypass the governed
# push path — repo changes go through stage_patch, never a direct commit).
BLOCKED_TOOLS = frozenset({
    "mkt_social_post",
    "comm_send_email", "comm_slack_message", "comm_sms_send",
    "comm_telegram_message", "comm_discord_message", "comm_push_notify",
    "vcs_git_commit", "vcs_github_pr",
})


def is_destructive(name):
    """True when a tool name is a destructive action (see module docstring)."""
    low = str(name or "").lower()
    if low in BLOCKED_TOOLS:
        return True
    if not any(word in low for word in DESTRUCTIVE_WORDS):
        return False
    # A read-only tool that merely mentions a destructive word is not
    # destructive (e.g. vcs_asset_release_audit audits releases).
    return not any(marker in low for marker in READONLY_MARKERS)


def load_domain_prefixes():
    """[(domain, [prefix, ...])] from surface.json; [] when unavailable."""
    try:
        surface = json.loads(Path(SURFACE).read_text())
    except Exception:
        return []
    out = []
    for entry in surface.get("domains_detail") or []:
        domain = entry.get("domain")
        prefixes = entry.get("prefixes") or []
        if domain and prefixes:
            out.append((domain, prefixes))
    return out


def domain_for(name, domain_prefixes):
    for domain, prefixes in domain_prefixes:
        for prefix in prefixes:
            if prefix.endswith("*") and name.startswith(prefix[:-1]):
                return domain
            if prefix == name:
                return domain
    return name.split("_", 1)[0] if "_" in name else "other"


def short_description(text, limit=80):
    one = " ".join(str(text or "").split())
    return one[:limit] + ("…" if len(one) > limit else "")


async def _session():
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    params = StdioServerParameters(
        command=VENV_PYTHON,
        args=[LAUNCHER],
        env={**os.environ, "PYTHONUNBUFFERED": "1", "MEM20_HEALTH_DISABLE": "1"},
        cwd=REPO_ROOT,
    )
    return stdio_client(params), ClientSession


async def list_all_tools():
    """Every tool the live MCP server offers, in one session."""
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    params = StdioServerParameters(
        command=VENV_PYTHON,
        args=[LAUNCHER],
        env={**os.environ, "PYTHONUNBUFFERED": "1", "MEM20_HEALTH_DISABLE": "1"},
        cwd=REPO_ROOT,
    )
    tools = []
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=300) as session:
            await session.initialize()
            cursor = None
            while True:
                page = await session.list_tools(
                    params={"cursor": cursor} if cursor else None
                )
                tools.extend(page.tools)
                cursor = page.next_cursor
                if not cursor:
                    break
    return tools


def load_catalog():
    """The catalog as a list of dicts, from the cache when fresh."""
    cache = Path(CATALOG_CACHE)
    if cache.exists():
        try:
            age = time.time() - cache.stat().st_mtime
            if age < CACHE_TTL_SECONDS:
                data = json.loads(cache.read_text())
                if isinstance(data, list) and data:
                    return data, True
        except Exception:
            pass
    return None, False


def save_catalog(catalog):
    try:
        Path(CATALOG_CACHE).write_text(json.dumps(catalog))
    except Exception as exc:
        print(f"toolchest: could not write catalog cache: {exc}", file=sys.stderr)


async def get_catalog():
    """List of {name, domain, description, args}; cached, refreshed live."""
    cached, fresh = load_catalog()
    if fresh:
        return cached
    tools = await list_all_tools()
    prefixes = load_domain_prefixes()
    catalog = []
    for tool in tools:
        schema = tool.input_schema or {}
        props = schema.get("properties") or {}
        required = schema.get("required") or []
        catalog.append({
            "name": tool.name,
            "domain": domain_for(tool.name, prefixes),
            "description": short_description(tool.description, 120),
            "args": sorted(set(list(props.keys()))),
            "required": sorted(set(required)),
        })
    catalog.sort(key=lambda t: t["name"])
    save_catalog(catalog)
    return catalog


def search_catalog(catalog, query, domain):
    words = [w for w in str(query or "").lower().split() if w]
    domain = (domain or "").strip().lower()
    scored = []
    for tool in catalog:
        if domain and tool["domain"].lower() != domain:
            continue
        name = tool["name"].lower()
        desc = tool["description"].lower()
        hay = f"{name} {desc}"
        if words and not all(w in hay for w in words):
            continue
        # Rank name matches above description-only matches, so a search
        # for "memory" surfaces the memory_* tools instead of the first
        # ten alphabetical tools whose descriptions merely mention memory.
        name_hits = sum(1 for w in words if w in name)
        desc_hits = sum(1 for w in words if w in desc)
        scored.append((-name_hits, -desc_hits, tool["name"], tool))
    scored.sort(key=lambda item: (item[0], item[1], item[2]))
    return [item[3] for item in scored[:MAX_SEARCH_RESULTS]]


async def call_tool(name, arguments):
    """Call one mem20 tool over a fresh MCP session; returns result text."""
    from mcp import ClientSession
    from mcp.client.stdio import StdioServerParameters, stdio_client

    params = StdioServerParameters(
        command=VENV_PYTHON,
        args=[LAUNCHER],
        env={**os.environ, "PYTHONUNBUFFERED": "1", "MEM20_HEALTH_DISABLE": "1"},
        cwd=REPO_ROOT,
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write, read_timeout_seconds=300) as session:
            await session.initialize()
            result = await session.call_tool(name, arguments=arguments)
            payload = result.model_dump(mode="json")
            if payload.get("isError"):
                texts = []
                for block in payload.get("content") or []:
                    if isinstance(block, dict) and block.get("text"):
                        texts.append(block["text"])
                raise RuntimeError("\n".join(texts) or f"mem20 tool {name} returned an error")
            texts = []
            for block in payload.get("content") or []:
                if isinstance(block, dict) and block.get("text"):
                    texts.append(block["text"])
            return "\n".join(texts)


async def cmd_search(query, domain):
    catalog = await get_catalog()
    hits = search_catalog(catalog, query, domain)
    print(json.dumps(
        {"tools": hits, "count": len(hits), "total": len(catalog)},
        ensure_ascii=False,
    ))
    return 0


async def cmd_call(name, arguments):
    if is_destructive(name):
        print(
            f"toolchest: refused {name} — destructive actions (delete, "
            "remove, destroy, spend, publish, release, sell, charge, "
            "refund) are not available through the toolchest",
            file=sys.stderr,
        )
        return 2
    try:
        text = await call_tool(name, arguments)
    except Exception as exc:
        print(f"toolchest: {name} failed: {exc}", file=sys.stderr)
        return 1
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "\n…[truncated to 8000 chars]"
    print(json.dumps({"tool": name, "result": text}, ensure_ascii=False))
    return 0


async def main(argv):
    if len(argv) < 2 or argv[1] not in ("search", "call"):
        print(
            "usage: toolchest.py search <query> [domain] | toolchest.py call <tool>",
            file=sys.stderr,
        )
        return 2
    if argv[1] == "search":
        query = argv[2] if len(argv) > 2 else ""
        domain = argv[3] if len(argv) > 3 else ""
        try:
            return await cmd_search(query, domain)
        except Exception as exc:
            print(f"toolchest: search failed: {exc}", file=sys.stderr)
            return 1
    name = argv[2] if len(argv) > 2 else ""
    if not name:
        print("toolchest: call needs a tool name", file=sys.stderr)
        return 2
    raw = sys.stdin.read()
    try:
        arguments = json.loads(raw) if raw.strip() else {}
    except Exception:
        print("toolchest: arguments on stdin must be one JSON object", file=sys.stderr)
        return 2
    if not isinstance(arguments, dict):
        print("toolchest: arguments must be a JSON object", file=sys.stderr)
        return 2
    return await cmd_call(name, arguments)


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(asyncio.wait_for(
            main(sys.argv), timeout=OVERALL_TIMEOUT_SECONDS)))
    except asyncio.TimeoutError:
        print(
            f"toolchest: timed out after {OVERALL_TIMEOUT_SECONDS}s",
            file=sys.stderr,
        )
        raise SystemExit(1)
