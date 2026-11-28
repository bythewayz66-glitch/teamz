# jnet2 local-model swap: Ollama → llama-server

Decision: Jesse, Nov 27 2026 — "if there is a better way than ollama for local models feel free to swap" + "Swap".

**APPROVED Nov 27 ~17:35: install Qwen3.5-9B + Qwen3.5-4B + Phi-4-mini via llama-server on jnet2 when it's up, and wire them into Teamz as providers.**

## Verdict

**llama-server (raw llama.cpp) wins for our use — on concurrency, not speed.**

- Ollama and llama.cpp are the same engine underneath (Ollama runs llama-server since 0.30). Single-request speed is within ~1% (120.6 vs 121.8 tok/s on a 9B model).
- The real difference: Ollama answers **one request at a time by default**; llama-server starts **4 parallel slots** and served 4 concurrent requests at ~2.5x Ollama's total throughput (100.2 vs 39.8 tok/s). Our fleet hits the local box with many agents at once, so this is the bottleneck that matters.
- llama-server also gives full control (context size, slot count, keep the model loaded permanently — no unload/reload churn) and continuous batching across slots.
- vLLM would be faster still (1,730 tok/s at 32 concurrent requests) but it needs a GPU. jnet1/jnet2 have none. Not applicable.
- CPU smoke tests show Ollama and llama-server give identical pass/fail on tool calls, so nothing is lost on capability.

Sources: homebrewserver.club Ollama vs llama.cpp benchmark (Nov 2026), SitePoint multi-user serving benchmark (Nov 17 2026), Agentic Weekly CPU smoke test (Oct 25 2026).

## Swap plan (when jnet2 is up)

jnet2 is a dedicated box: 1TB disk, 16GB RAM, nothing but the model server.

1. Install llama.cpp release (prebuilt `llama-server` binary) — no Ollama.
2. Download GGUFs from Hugging Face (verify exact repo names at install time; Qwen's pattern is `Qwen/Qwen3.5-9B-GGUF`, `Qwen/Qwen3.5-4B-GGUF`; Phi-4-mini GGUF from Microsoft's repo):
   - **Qwen3.5-9B** (Q4_K_M, ~6GB) — main workhorse, best small tool-calling model (BFCL 66.1), 262K context
   - **Qwen3.5-4B** (Q4_K_M, ~2.5GB) — fast tier for light jobs
   - **Phi-4-mini** (Q4_K_M, ~2.6GB) — reasoning/logic checks
   - Skip 12–14B (slow on old CPU, marginal gain) and DeepSeek-R1-Distill (verbose reasoning traces eat context).
3. Run llama-server as a systemd service, one model per instance (16GB RAM = one model loaded at a time comfortably):
   `llama-server -m <qwen3.5-9b.gguf> --port 8080 -np 4 --ctx-size 32768`
   (Add `--jinja` only if the stock chat template mishandles tool calls; Qwen GGUFs ship with tool-call templates.)
4. Point Teamz at it: Teamz calls providers through `callGenericProvider` (OpenAI-compatible `/v1/chat/completions`), verified in `/opt/teamz-agent/agent.mjs` — so llama-server is a **config-only change**, no code. New provider entries in `/var/lib/teamz-agent/providers.json`:
   - baseUrl `http://<jnet2-tailscale-ip>:8080/v1`, model `qwen3.5-9b` (etc.), keyless.
5. Verify before migrating traffic: curl a chat completion with a tool call against the endpoint, then run one real agent dispatch through it and check the result.
6. **jnet1 keeps Ollama** (qwen2.5-coder:0.5b + gemma3:1b, already live and registered) until the jnet2 setup proves itself. Then decide whether to retire jnet1's Ollama or keep it as a fallback.

## Vision — the Hermes pattern (Jesse, Nov 27 ~17:37)

Don't make the main model multimodal. Hermes Agent's trick is a **two-path architecture**:

- Main model supports vision natively → send the image as real pixels (native multimodal).
- Main model is text-only (ours are) → a `vision_analyze` auxiliary tool calls a **separate small vision model**, which describes the image in text, and the description is injected back as context for the main model to read.

Native is faster (no pre-analysis hop), but text descriptions cache cleanly while native image parts break prompt caching — so the text route is the right default for a fleet that re-uses context. The original Hermes 2 Vision model used the same lightweight thinking: a tiny SigLIP-400M vision encoder instead of the usual 3B encoder.

**What this changes for jnet2:** drop Gemma 4 E4B as a full multimodal main model. Instead add a small dedicated "eyes" model in the auxiliary slot:
- Candidates (verify GGUF + llama-server mtmd support at install): **Moondream2** (~1.9B, smallest, built for CPU/edge image description), **Qwen2.5-VL-3B**, **Gemma 3 4B**.
- The eyes model only answers "what's in this image" — the main text models (Qwen3.5-9B etc.) do all the reasoning on the description.

Also noted: **Hermes 4 14B** (Qwen3 base, Apache 2.0, hybrid reasoning, first-class tool calling) is a full candidate for the main slot — Jesse says slow is OK for now, so benchmark it head-to-head with Qwen3.5-9B on quality (tool calling, reasoning), not just speed. Hermes 4 70B/405B are far too big for this box.

## Disk use — all four approved (Jesse, Nov 27 ~17:42)

jnet2's 1TB: models use ~25GB, ~950GB free. Approved uses:
1. **Model bench (~100–200GB):** shelf of alternates downloaded and ready — different quants, Hermes 4 14B in a couple of sizes, embedding models — instant swaps/benchmarks.
2. **jnet1 backups (~160GB):** full copy of jnet1 (222GB disk, 158GB used) plus snapshots — mem20, Teamz state, everything recoverable if jnet1 dies.
3. **Z Corps media archive:** permanent home for episode cuts (1.1GB each), character cards, comic PDFs, and all future episodes.
4. **Local knowledge corpus for the agents:** mem20 docs, comics, La Jara records, embedded and searchable on the box.
Realistic total ~300–400GB, half the drive still free. Set up when jnet2 is live, alongside llama-server + the models.

## Why not swap jnet1 now

jnet1 is live with 106 agents and load average ~7.6 on a 4-core i5-6300U with no GPU. Ripping out its working Ollama for an unproven swap risks the fleet for a small payoff. jnet2 is the clean place to prove the new setup.
