#!/usr/bin/env python3
"""
Simple static server that mounts the project under a subpath on localhost.

Defaults:
- Auto-picks a free port (port=0)
- Mount prefix: /app/
- Serves repository root (parent of this file)

Usage examples:
  python3 serve.py
  python3 serve.py --port 51745 --prefix /dangjik/
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import os
import socketserver
import sys
import threading
import webbrowser


def find_repo_root() -> str:
  here = os.path.abspath(os.path.dirname(__file__))
  return os.path.abspath(os.path.join(here, os.pardir))


class PrefixedHandler(http.server.SimpleHTTPRequestHandler):
  def __init__(self, *args, directory: str | None = None, prefix: str = "/app/", **kwargs):
    self.base_directory = directory or os.getcwd()
    # Ensure prefix begins and ends with '/'
    pref = prefix if prefix.startswith('/') else '/' + prefix
    self.prefix = pref if pref.endswith('/') else pref + '/'
    super().__init__(*args, directory=self.base_directory, **kwargs)

  def do_GET(self):  # noqa: N802
    # Redirect root to prefix
    if self.path in ("", "/"):
      self.send_response(302)
      self.send_header("Location", self.prefix)
      self.end_headers()
      return
    # Only serve paths under the prefix
    if not self.path.startswith(self.prefix):
      self.send_error(404, "Not found")
      return
    # Strip prefix so the base directory maps to '/'
    self.path = self.path[len(self.prefix) - 1 :]  # keep leading '/'
    super().do_GET()

  def do_HEAD(self):  # noqa: N802
    if not self.path.startswith(self.prefix):
      self.send_error(404, "Not found")
      return
    self.path = self.path[len(self.prefix) - 1 :]
    super().do_HEAD()


def serve(port: int, prefix: str, root: str, open_browser: bool) -> None:
  handler = lambda *args, **kw: PrefixedHandler(*args, directory=root, prefix=prefix, **kw)
  # Reuse address to avoid TIME_WAIT issues
  class ReuseTCPServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True

  with ReuseTCPServer(("", port), handler) as httpd:
    # If port=0, get the chosen port
    host, chosen_port = httpd.server_address
    url = f"http://localhost:{chosen_port}{prefix}"
    print(f"Serving {root}\n→ {url}")

    if open_browser:
      # Open browser after the server is ready
      t = threading.Timer(0.3, lambda: webbrowser.open(url))
      t.daemon = True
      t.start()

    try:
      httpd.serve_forever()
    except KeyboardInterrupt:
      print("\nShutting down...")


def main(argv: list[str] | None = None) -> int:
  p = argparse.ArgumentParser(description="Serve project with a subpath on a unique port")
  p.add_argument("--port", type=int, default=0, help="Port to bind (0 = auto-pick a free port)")
  p.add_argument("--prefix", type=str, default="/app/", help="Mount path prefix (e.g., /app/ or /dangjik/)")
  p.add_argument("--root", type=str, default=find_repo_root(), help="Directory to serve (default: repo root)")
  p.add_argument("--open", action="store_true", help="Open the browser at the served URL")
  args = p.parse_args(argv)

  root = os.path.abspath(args.root)
  if not os.path.isdir(root):
    print(f"Root does not exist or is not a directory: {root}", file=sys.stderr)
    return 2

  # Validate prefix
  pref = args.prefix if args.prefix.startswith('/') else '/' + args.prefix
  if not pref.endswith('/'):
    pref += '/'

  serve(args.port, pref, root, args.open)
  return 0


if __name__ == "__main__":
  raise SystemExit(main())

