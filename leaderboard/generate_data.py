#!/usr/bin/env python3
"""Generate deterministic per-model leaderboard artifacts from the raw baseline."""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path

from leaderboard_data import (
    LeaderboardDataError,
    build_artifact,
    extract_records,
    json_bytes,
    load_json,
    manifest_model_paths,
    make_manifest,
    summarize_artifact,
    transactional_write,
    validate_artifact,
    validate_coverage_contract,
    validate_manifest,
    validate_submission,
)

HERE = Path(__file__).resolve().parent
DEFAULT_MODELS = HERE / "data/models"
DEFAULT_MANIFEST = HERE / "data/manifest.json"
DEFAULT_CONTRACT = HERE / "data/coverage_contract.json"
DEFAULT_SUBMISSION_DIRS = (
    HERE / "data/baseline_submissions",
    HERE / "data/submissions",
)


def _print_summary(artifact: dict) -> None:
    summary = summarize_artifact(artifact)
    coverage = summary["coverage"]
    print(
        f"{summary['model_id']}: {summary['runs']} physical runs, "
        f"{summary['logical_entries']} logical entries, {summary['records']} folds, "
        f"coverage {coverage['observed_result_cells']}/{coverage['expected_result_cells']} "
        f"({coverage['status']})"
    )
    for key, item in coverage["by_model_preprocess_key"].items():
        if item["status"] != "complete":
            print(
                f"  {key}: missing {item['missing_result_cells']} {item['missing_by_dataset']}"
            )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--outputs-dir", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--coverage-contract", type=Path, default=DEFAULT_CONTRACT)
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
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        outputs = args.outputs_dir.resolve()
        if not outputs.is_dir():
            raise LeaderboardDataError(f"raw baseline not found: {outputs}")
        contract = validate_coverage_contract(
            load_json(args.coverage_contract.resolve())
        )
        submissions = {}
        submission_dirs = args.submission_dirs or list(DEFAULT_SUBMISSION_DIRS)
        for directory in submission_dirs:
            directory = directory.resolve()
            if not directory.is_dir():
                raise LeaderboardDataError(
                    f"submission metadata directory not found: {directory}"
                )
            for path in sorted(directory.glob("*.json")):
                submission = validate_submission(load_json(path))
                if submission["model_id"] in submissions:
                    raise LeaderboardDataError(
                        f"duplicate submission metadata for {submission['model_id']}"
                    )
                submissions[submission["model_id"]] = submission
        raw_records = extract_records(outputs, contract=contract)
        by_model: dict[str, list[dict]] = defaultdict(list)
        for record in raw_records:
            by_model[record["model_id"]].append(record)
        missing_submissions = set(by_model) - set(submissions)
        if missing_submissions:
            raise LeaderboardDataError(
                f"raw models are missing reviewed submission metadata: "
                f"{sorted(missing_submissions)}"
            )
        artifacts = {
            model_id: build_artifact(submissions[model_id], records, contract)
            for model_id, records in sorted(by_model.items())
        }
        for artifact in artifacts.values():
            _print_summary(artifact)

        models_dir = args.models_dir.resolve()
        manifest_path = args.manifest.resolve()
        if manifest_path.exists():
            existing_manifest = load_json(manifest_path)
            validate_manifest(existing_manifest, manifest_path.parent)
            for relative in manifest_model_paths(existing_manifest):
                validate_artifact(load_json(manifest_path.parent / relative), contract)
        changes: dict[Path, bytes] = {}
        conflicts = []
        for model_id, artifact in artifacts.items():
            target = models_dir / f"{model_id}.json"
            proposed = json_bytes(artifact)
            if target.exists() and target.read_bytes() != proposed:
                conflicts.append(model_id)
            if not target.exists() or target.read_bytes() != proposed:
                changes[target] = proposed
        existing_ids = (
            {path.stem for path in models_dir.glob("*.json")}
            if models_dir.exists()
            else set()
        )
        unpublished_ids = {
            Path(relative).stem
            for relative in (
                existing_manifest.get("unpublished_models", [])
                if manifest_path.exists()
                else []
            )
        }
        manifest = make_manifest(
            sorted(existing_ids | set(artifacts)), sorted(unpublished_ids)
        )
        manifest_bytes = json_bytes(manifest)
        if not manifest_path.exists() or manifest_path.read_bytes() != manifest_bytes:
            changes[manifest_path] = manifest_bytes
        if conflicts and not args.overwrite:
            raise LeaderboardDataError(
                f"differing artifacts already exist for {conflicts}; rerun with --overwrite after review"
            )
        if args.dry_run:
            print(f"dry-run: would update {len(changes)} file(s)")
            return 0
        if not changes:
            print("unchanged")
            return 0
        transactional_write(changes)
        validate_manifest(load_json(manifest_path), manifest_path.parent)
        print(f"wrote {len(changes)} file(s)")
        return 0
    except LeaderboardDataError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
