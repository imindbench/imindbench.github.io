#!/usr/bin/env python3
"""Validate every checked-in leaderboard artifact and supporting manifest."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from leaderboard_data import (
    DEFAULT_DECODABLE_DIR,
    LeaderboardDataError,
    build_data_bundle_bytes,
    load_cohort_cells,
    load_json,
    manifest_model_paths,
    validate_artifact,
    validate_coverage_contract,
    validate_manifest,
    validate_submission,
)

HERE = Path(__file__).resolve().parent
DEFAULT_SUBMISSION_DIRS = (
    HERE / "data/baseline_submissions",
    HERE / "data/submissions",
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


def load_submissions(directories: list[Path]) -> dict[str, dict]:
    submissions: dict[str, dict] = {}
    for directory in directories:
        directory = directory.resolve()
        if not directory.is_dir():
            raise LeaderboardDataError(
                f"submission metadata directory not found: {directory}"
            )
        for path in sorted(directory.glob("*.json")):
            submission = validate_submission(load_json(path))
            model_id = submission["model_id"]
            if model_id != path.stem:
                raise LeaderboardDataError(
                    f"{path}: filename does not match model_id {model_id!r}"
                )
            if model_id in submissions:
                raise LeaderboardDataError(
                    f"duplicate submission metadata for {model_id}"
                )
            submissions[model_id] = submission
    return submissions


def cross_check_submissions(
    submissions: dict[str, dict], artifact_models: dict[str, dict]
) -> None:
    """Require reviewed metadata and published artifacts to correspond exactly."""
    undocumented = sorted(set(artifact_models) - set(submissions))
    if undocumented:
        raise LeaderboardDataError(
            f"listed models without submission metadata: {undocumented}"
        )
    unpublished = sorted(set(submissions) - set(artifact_models))
    if unpublished:
        raise LeaderboardDataError(
            f"submission metadata without a model artifact: {unpublished}"
        )
    for model_id, model in sorted(artifact_models.items()):
        reviewed = {
            field: value
            for field, value in submissions[model_id].items()
            if field != "schema_version"
        }
        if model != reviewed:
            raise LeaderboardDataError(
                f"{model_id}: artifact metadata differs from its submission file"
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=HERE / "data")
    parser.add_argument("--decodable-dir", type=Path, default=DEFAULT_DECODABLE_DIR)
    parser.add_argument("--data-bundle", type=Path)
    parser.add_argument(
        "--submissions-dir",
        type=Path,
        action="append",
        dest="submission_dirs",
        help=(
            "Directory containing reviewed model metadata. May be repeated. "
            "Defaults to data/baseline_submissions and data/submissions."
        ),
    )
    args = parser.parse_args(argv)
    try:
        data_dir = args.data_dir.resolve()
        contract = validate_coverage_contract(
            load_json(data_dir / "coverage_contract.json")
        )
        validate_decodable_manifests(args.decodable_dir, contract)
        cohorts = load_cohort_cells(args.decodable_dir, contract)
        manifest = load_json(data_dir / "manifest.json")
        validate_manifest(manifest, data_dir)
        artifact_paths = manifest_model_paths(manifest)
        artifact_models: dict[str, dict] = {}
        for relative in artifact_paths:
            artifact = load_json(data_dir / relative)
            validate_artifact(artifact, contract, cohorts)
            artifact_models[artifact["model"]["model_id"]] = artifact["model"]
        submissions = load_submissions(
            args.submission_dirs or list(DEFAULT_SUBMISSION_DIRS)
        )
        cross_check_submissions(submissions, artifact_models)
        expected_bundle = build_data_bundle_bytes(data_dir, args.decodable_dir)
        data_bundle = (
            args.data_bundle.resolve()
            if args.data_bundle
            else data_dir.parent / "data_bundle.js"
        )
        if not data_bundle.is_file() or data_bundle.read_bytes() != expected_bundle:
            raise LeaderboardDataError(
                f"{data_bundle}: data bundle is missing or stale; "
                "run build_data_bundle.py"
            )
        print(
            f"validated {len(artifact_paths)} model artifacts "
            f"and {len(submissions)} submissions"
        )
        return 0
    except LeaderboardDataError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
