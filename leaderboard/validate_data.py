#!/usr/bin/env python3
"""Validate every checked-in leaderboard artifact and supporting manifest."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from leaderboard_data import (
    LeaderboardDataError,
    load_json,
    manifest_model_paths,
    validate_artifact,
    validate_coverage_contract,
    validate_manifest,
)

HERE = Path(__file__).resolve().parent
DEFAULT_DECODABLE_DIR = (
    HERE / "decodable_subject_sessions" / "stft_or_htnet_500hz_val_mean0p60"
)


def validate_decodable_manifests(directory: Path, contract: dict) -> None:
    for dataset, spec in contract["datasets"].items():
        path = directory / f"{dataset}.json"
        payload = load_json(path)
        if not isinstance(payload, dict) or not isinstance(payload.get("tasks"), dict):
            raise LeaderboardDataError(f"{path}: missing tasks object")
        if set(payload["tasks"]) != set(spec["tasks"]):
            raise LeaderboardDataError(
                f"{path}: task set differs from coverage contract"
            )
        for task, task_data in payload["tasks"].items():
            sessions = task_data.get("subject_sessions")
            if not isinstance(sessions, list) or len(sessions) != len(set(sessions)):
                raise LeaderboardDataError(
                    f"{path}: {task} subject_sessions must be unique"
                )
            if task_data.get("n_subject_sessions") != len(sessions):
                raise LeaderboardDataError(
                    f"{path}: {task} n_subject_sessions is incorrect"
                )
            for field in ("mean_test_roc_auc", "max_test_roc_auc"):
                value = task_data.get(field)
                if value is not None and (
                    isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not 0 <= value <= 1
                ):
                    raise LeaderboardDataError(f"{path}: {task}.{field} is invalid")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=HERE / "data")
    args = parser.parse_args(argv)
    try:
        data_dir = args.data_dir.resolve()
        contract = validate_coverage_contract(
            load_json(data_dir / "coverage_contract.json")
        )
        manifest = load_json(data_dir / "manifest.json")
        validate_manifest(manifest, data_dir)
        artifact_paths = manifest_model_paths(manifest)
        for relative in artifact_paths:
            validate_artifact(load_json(data_dir / relative), contract)
        validate_decodable_manifests(DEFAULT_DECODABLE_DIR, contract)
        print(f"validated {len(artifact_paths)} model artifacts")
        return 0
    except LeaderboardDataError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
