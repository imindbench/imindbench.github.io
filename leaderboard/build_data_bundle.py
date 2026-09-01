#!/usr/bin/env python3
"""Build the JavaScript data bundle used by browsers and local file previews."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from leaderboard_data import (
    DEFAULT_DECODABLE_DIR,
    LeaderboardDataError,
    build_data_bundle_bytes,
    sync_data_bundle,
)

HERE = Path(__file__).resolve().parent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=HERE / "data")
    parser.add_argument("--decodable-dir", type=Path, default=DEFAULT_DECODABLE_DIR)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    try:
        expected = build_data_bundle_bytes(args.data_dir, args.decodable_dir)
        output = (
            args.output.resolve()
            if args.output
            else args.data_dir.resolve().parent / "data_bundle.js"
        )
        if args.check:
            if not output.is_file() or output.read_bytes() != expected:
                raise LeaderboardDataError(
                    f"{output}: data bundle is missing or stale; run build_data_bundle.py"
                )
            print(f"validated {output.name}")
            return 0
        if output.is_file() and output.read_bytes() == expected:
            print("unchanged")
            return 0
        sync_data_bundle(args.data_dir, args.decodable_dir, output)
        print(f"wrote {output}")
        return 0
    except (LeaderboardDataError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
