#!/usr/bin/env python3
"""Serve the self-contained leaderboard on one local origin."""

from __future__ import annotations

import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


LEADERBOARD_DIR = Path(__file__).resolve().parent


class LeaderboardRequestHandler(SimpleHTTPRequestHandler):
    """Serve files exclusively from the leaderboard directory."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(LEADERBOARD_DIR), **kwargs)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), LeaderboardRequestHandler)
    print(f"Serving iMINDBench at http://localhost:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
