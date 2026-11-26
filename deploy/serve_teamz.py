#!/usr/bin/env python3
"""Serve the Teamz production build (dist/) on jnet1, tailnet-only.

The Vite build uses base '/teamz/' (GitHub Pages), so the app and its
assets live under /teamz/*. This stdlib-only server maps /teamz/* onto
dist/ and redirects / to /teamz/. No Node needed on the server.

Binds 0.0.0.0:8895 by default. jnet1 has no public IP, so this is
tailnet-only by construction. Logs go to stderr (journald via the
systemd unit teamz-ui.service).

Env overrides: TEAMZ_DIST (default /opt/teamz-ui/dist),
TEAMZ_HOST (default 0.0.0.0), TEAMZ_PORT (default 8895).
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

DIST = os.environ.get("TEAMZ_DIST", "/opt/teamz-ui/dist")
HOST = os.environ.get("TEAMZ_HOST", "0.0.0.0")
PORT = int(os.environ.get("TEAMZ_PORT", "8895"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIST, **kwargs)

    def send_response(self, code, message=None):
        super().send_response(code, message)
        # Cache policy. Jesse hit a stale render because the server sent
        # no Cache-Control at all (only Last-Modified), so browsers
        # heuristically cached index.html. index.html must be revalidated
        # on every load; hashed /assets/* files are immutable and safe to
        # cache for a year.
        if code != 200:
            return
        p = urlsplit(self.path).path
        if p == "/" or p.endswith("/") or p.endswith(".html"):
            self.send_header("Cache-Control", "no-cache")
        elif p.startswith("/assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")

    def _route(self):
        """Rewrite the request path. Returns False if already answered."""
        raw = urlsplit(self.path)
        p = raw.path
        if p in ("/", ""):
            self.send_response(302)
            self.send_header("Location", "/teamz/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return False
        if p == "/teamz" or p.startswith("/teamz/"):
            rest = p[len("/teamz"):] or "/"
            self.path = rest + (("?" + raw.query) if raw.query else "")
            return True
        self.send_error(404, "Not found")
        return False

    def do_GET(self):
        if self._route():
            super().do_GET()

    def do_HEAD(self):
        if self._route():
            super().do_HEAD()

    def list_directory(self, path):
        # No directory listings on a UI server.
        self.send_error(404, "Not found")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    if not os.path.isfile(os.path.join(DIST, "index.html")):
        sys.stderr.write("teamz dist not found at %s\n" % DIST)
        sys.exit(1)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
