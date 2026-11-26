# Teamz web UI on jnet1 — deploy README

**Status: READY TO DEPLOY — blocked only on jnet1 shell access.**
SSH to jnet1 (100.87.46.34) rejects key auth for both `root` and `jayson`
(the VM's Ed25519 key is not in jnet1's `authorized_keys`); verified
2026-11-26 by direct test through the Tailscale relay. No root password
is available. Everything below is prepared; the deploy itself is one
staging step + one install script once a shell exists.

## What is ready (verified locally, 2026-11-26)

- `dist/` — freshly built (`npm run build`, vite 5.4.21, 81 modules):
  `index.html` + `assets/index-COLrnInp.js` (491 KB) +
  `assets/index-Dlisj5sM.css` (38 KB).
- Verified via `vite preview`: `GET /teamz/` → **HTTP 200**, title
  **"teamz — your agent workspace"**, JS asset → 200. `/` redirects to
  `/teamz/` (302).
- **Port 8895** — checked free against `jnet1-frontend-inventory.md`
  (8890 mem20controlz, 8891 mem20shopz, 8892 scoreboard, 3000 chat,
  4000 gateway, 8080 mcp, 4210 bigpickle, 8765 oreo, etc. in use).
- **Serving choice: Python stdlib static server** (`serve_teamz.py`),
  not nginx — nginx presence on jnet1 is unverified and Node is not
  needed for a static build. The wrapper is required (not plain
  `http.server`) because the Vite build uses base `/teamz/`: it maps
  `/teamz/*` onto `dist/` and redirects `/` → `/teamz/`.
- Systemd unit `teamz-ui.service`: runs as system user `teamz`,
  `Restart=always`, logs to journald (`journalctl -u teamz-ui`).

## Deploy steps (once jnet1 shell access exists)

From this VM, with the Tailscale relay running:

```bash
# 1. Start the relay (background) — reaches jnet1:22 through the proxy
python3 ~/workspace/tools/adb_relay.py 45381 100.87.46.34 22

# 2. Stage the payload on jnet1
ssh -p 45381 root@127.0.0.1 'mkdir -p /tmp/teamz-ui-deploy'
scp -P 45381 -r ~/workspace/teamz/dist \
  ~/workspace/teamz/deploy/serve_teamz.py \
  ~/workspace/teamz/deploy/teamz-ui.service \
  ~/workspace/teamz/deploy/install-teamz-ui.sh \
  root@127.0.0.1:/tmp/teamz-ui-deploy/

# 3. Install + start + verify on jnet1
ssh -p 45381 root@127.0.0.1 'bash /tmp/teamz-ui-deploy/install-teamz-ui.sh'

# 4. Verify over the tailnet from this VM (proxy carries TCP)
curl --proxy "${HTTPS_PROXY%:*}:3130" -s -o /dev/null -w "HTTP %{http_code}\n" \
  http://100.87.46.34:8895/teamz/
```

## URL for Jesse's phone (once deployed)

**http://100.87.46.34:8895/teamz/** — tailnet only (jnet1 has no public
IP; nothing is exposed publicly). The bare root
`http://100.87.46.34:8895/` redirects to `/teamz/`.

## Caveats (honest)

- **Agent replies not verified end-to-end from here.** The app loads
  (200 + title + assets). The earlier report that the Pollinations
  anonymous tier rejects `localhost` origins should be fixed by serving
  from the tailnet IP instead of localhost, but only Jesse opening it
  on his phone and getting an agent reply will confirm that.
- The existing `deploy/install.sh` + `teamz-runner.service` (the 24/7
  autonomy runner) are untouched — this is a separate, additional
  service (`teamz-ui.service`) for the web UI only.
