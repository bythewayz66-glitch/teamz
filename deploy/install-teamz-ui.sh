#!/usr/bin/env bash
# Install the Teamz web UI on jnet1.
#
# Run as root ON jnet1, with the deploy payload staged at /tmp/teamz-ui-deploy/
# containing: dist/  serve_teamz.py  teamz-ui.service
# (see README-teamz-ui.md for the exact staging commands from the VM).
#
# What it does:
#   1. Checks for python3 (stdlib only — no Node needed on the server).
#   2. Creates a `teamz` system user if missing (the runner install
#      creates the same user; this is a no-op if it already exists).
#   3. Copies dist/ to /opt/teamz-ui/dist and serve_teamz.py to /opt/teamz-ui/.
#   4. Installs and enables teamz-ui.service, then starts it.
#   5. Verifies locally: /teamz/ returns HTTP 200 with the right title.
#
# What it never does: touch credentials, the mem20 checkout, gamut-clone,
# or any other live service. Port 8895 was checked against the jnet1
# frontend inventory (8890 controlz, 8891 shopz, 8892 scoreboard in use).
set -euo pipefail

STAGE="/tmp/teamz-ui-deploy"
DEST="/opt/teamz-ui"

if [[ "$EUID" -ne 0 ]]; then
  echo "install-teamz-ui.sh must run as root" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is not installed" >&2
  exit 1
fi
if [[ ! -d "$STAGE/dist" || ! -f "$STAGE/serve_teamz.py" || ! -f "$STAGE/teamz-ui.service" ]]; then
  echo "payload missing in $STAGE (need dist/, serve_teamz.py, teamz-ui.service)" >&2
  exit 1
fi

if ! id teamz >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/teamz-runner --shell /usr/sbin/nologin teamz
  echo "created system user teamz"
fi

mkdir -p "$DEST"
rm -rf "$DEST/dist"
cp -r "$STAGE/dist" "$DEST/dist"
cp "$STAGE/serve_teamz.py" "$DEST/serve_teamz.py"
chmod 755 "$DEST/serve_teamz.py"
chown -R teamz:teamz "$DEST"
chmod -R a+rX "$DEST"

cp "$STAGE/teamz-ui.service" /etc/systemd/system/teamz-ui.service
systemctl daemon-reload
systemctl enable --now teamz-ui.service
sleep 2
systemctl --no-pager status teamz-ui.service --lines=5 || true

echo "--- verify ---"
curl -s -o /tmp/teamz-ui-check.html -w "GET /teamz/ -> HTTP %{http_code}\n" http://127.0.0.1:8895/teamz/
grep -o "<title>[^<]*</title>" /tmp/teamz-ui-check.html || echo "WARNING: title not found in response"
curl -s -o /dev/null -w "GET / -> HTTP %{http_code} (expect 302 to /teamz/)\n" http://127.0.0.1:8895/
echo "Teamz UI should now be live at http://100.87.46.34:8895/teamz/ (tailnet only)"
