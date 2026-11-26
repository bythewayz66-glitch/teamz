#!/usr/bin/env bash
# Install the teamz 24/7 autonomy runner on jnet1.
#
# Run from the teamz repo root, as root, AFTER Jesse approves the install:
#   sudo ./deploy/install.sh
#
# What it does:
#   1. Checks for Node 20+ (the runner ships as a bundled .mjs file built
#      by `npm run build:runner` — plain ESM, no build step on the server).
#   2. Creates a `teamz` system user and the service directories.
#   3. Copies the bundled runner (dist/runner.mjs) to /opt/teamz-runner.
#   4. Seeds /var/lib/teamz-runner/state.json from the example — only if
#      no state file exists yet, so a reinstall never wipes live jobs.
#   5. Installs and enables the systemd unit. It does NOT start the
#      service: start it explicitly once the state file points at real
#      agents and a real repo checkout (see the README deploy section).
#
# What it never does: install anything from the network, touch credentials,
# sync the mem20 checkout, or push anything to the mem20 repo. The mem20
# checkout on jnet1 is already at /opt/mem20; syncing it is blocked pending
# Jesse's go-ahead, so the runner works with it as it stands — point job
# workdirs at it in the state file.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$REPO_DIR/dist/runner.mjs"
UNIT_SRC="$REPO_DIR/deploy/teamz-runner.service"
EXAMPLE_STATE="$REPO_DIR/scripts/runner-state.example.json"

if [[ "$EUID" -ne 0 ]]; then
  echo "install.sh must run as root (sudo ./deploy/install.sh)" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is not installed. Install Node 20+ first." >&2
  exit 1
fi
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "node $NODE_MAJOR is too old: the runner needs Node 20+." >&2
  exit 1
fi

if [[ ! -f "$BUNDLE" ]]; then
  echo "dist/runner.mjs not found. Build it first: npm run build:runner" >&2
  exit 1
fi

if ! id teamz >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/teamz-runner --shell /usr/sbin/nologin teamz
  echo "created system user teamz"
fi

mkdir -p /opt/teamz-runner /var/lib/teamz-runner /var/log/teamz-runner
cp "$BUNDLE" /opt/teamz-runner/runner.mjs
chmod 755 /opt/teamz-runner/runner.mjs

if [[ ! -f /var/lib/teamz-runner/state.json ]]; then
  cp "$EXAMPLE_STATE" /var/lib/teamz-runner/state.json
  echo "seeded /var/lib/teamz-runner/state.json from the example — edit it before starting"
else
  echo "keeping existing /var/lib/teamz-runner/state.json"
fi

chown -R teamz:teamz /opt/teamz-runner /var/lib/teamz-runner /var/log/teamz-runner
chmod 700 /var/lib/teamz-runner
chmod 600 /var/lib/teamz-runner/state.json

cp "$UNIT_SRC" /etc/systemd/system/teamz-runner.service
systemctl daemon-reload
systemctl enable teamz-runner.service

echo
echo "Installed. Next steps (do these by hand, after review):"
echo "  1. Edit /var/lib/teamz-runner/state.json — real agent endpoints,"
echo "     real job workdirs (the mem20 checkout on jnet1 is /opt/mem20),"
echo "     and the jobs you want running."
echo "  2. systemctl start teamz-runner"
echo "  3. journalctl -u teamz-runner -f   (or tail /var/log/teamz-runner/runner.log)"
