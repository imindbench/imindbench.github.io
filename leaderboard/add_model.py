#!/usr/bin/env python3
"""Create or intentionally replace one complete leaderboard model artifact."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from leaderboard_data import (
    DEFAULT_DECODABLE_DIR,
    LeaderboardDataError,
    build_artifact,
    classify_coverage_cohort,
    extract_records,
    json_bytes,
    load_cohort_cells,
    load_json,
    manifest_model_paths,
    make_manifest,
    summarize_artifact,
    sync_data_bundle,
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


def _cohort_label(artifact: dict, cohorts: dict) -> str:
    try:
        return classify_coverage_cohort(
            artifact["runs"], artifact["records"], cohorts
        )
    except (LeaderboardDataError, KeyError, TypeError):
        return "not an admissible cohort"


def _summary_lines(artifact: dict, cohorts: dict) -> list[str]:
    summary = summarize_artifact(artifact)
    coverage = summary["coverage"]
    lines = [
        f"model: {summary['model_id']}",
        f"physical runs: {summary['runs']}",
        f"logical entries: {summary['logical_entries']}",
        f"fold records: {summary['records']}",
        f"datasets: {', '.join(summary['datasets'])}",
        f"tasks: {len(summary['tasks'])}",
        f"coverage: {coverage['observed_result_cells']}/{coverage['expected_result_cells']} ({coverage['status']})",
        f"cohort: {_cohort_label(artifact, cohorts)}",
    ]
    for key, item in coverage["by_model_preprocess_key"].items():
        lines.append(
            f"  {key}: {item['observed_result_cells']}/{item['expected_result_cells']} cells, "
            f"{item['fold_records']} folds, missing by dataset={item['missing_by_dataset']}"
        )
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-outputs", type=Path, required=True)
    parser.add_argument("--submission", type=Path, required=True)
    parser.add_argument("--models-dir", type=Path, default=DEFAULT_MODELS)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--coverage-contract", type=Path, default=DEFAULT_CONTRACT)
    parser.add_argument("--decodable-dir", type=Path, default=DEFAULT_DECODABLE_DIR)
    parser.add_argument("--data-bundle", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        submission = validate_submission(load_json(args.submission.resolve()))
        contract = validate_coverage_contract(
            load_json(args.coverage_contract.resolve())
        )
        cohorts = load_cohort_cells(args.decodable_dir.resolve(), contract)
        records = extract_records(
            args.model_outputs.resolve(),
            expected_model_id=submission["model_id"],
            contract=contract,
        )
        artifact = build_artifact(submission, records, contract, cohorts)
        print("\n".join(_summary_lines(artifact, cohorts)))
        models_dir = args.models_dir.resolve()
        manifest_path = args.manifest.resolve()
        data_bundle_path = (
            args.data_bundle.resolve()
            if args.data_bundle
            else manifest_path.parent.parent / "data_bundle.js"
        )
        if manifest_path.exists():
            existing_manifest = load_json(manifest_path)
            validate_manifest(existing_manifest, manifest_path.parent)
            for relative in manifest_model_paths(existing_manifest):
                validate_artifact(
                    load_json(manifest_path.parent / relative), contract, cohorts
                )
        target = models_dir / f"{submission['model_id']}.json"
        proposed = json_bytes(artifact)
        differs = target.exists() and target.read_bytes() != proposed
        if differs and not args.overwrite:
            try:
                existing = load_json(target)
                print("existing artifact:")
                print(
                    "\n".join(
                        f"  {line}" for line in _summary_lines(existing, cohorts)
                    )
                )
                print("proposed artifact:")
                print(
                    "\n".join(
                        f"  {line}" for line in _summary_lines(artifact, cohorts)
                    )
                )
            except (LeaderboardDataError, KeyError, TypeError):
                print("existing artifact could not be summarized", file=sys.stderr)
            if args.dry_run:
                print("dry-run: update requires --overwrite", file=sys.stderr)
            else:
                print(
                    "existing artifact differs; review the summary and rerun with --overwrite",
                    file=sys.stderr,
                )
            return 2
        if target.exists() and target.read_bytes() == proposed:
            if not args.dry_run and sync_data_bundle(
                manifest_path.parent,
                args.decodable_dir.resolve(),
                data_bundle_path,
            ):
                print("updated data_bundle.js")
                return 0
            print("unchanged")
            return 0
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
            sorted(existing_ids | {submission["model_id"]}),
            sorted(unpublished_ids),
        )
        changes = {target: proposed, manifest_path: json_bytes(manifest)}
        if args.dry_run:
            print(
                f"dry-run: would {'replace' if target.exists() else 'create'} {target.name}"
            )
            return 0
        transactional_write(changes)
        validate_manifest(load_json(manifest_path), manifest_path.parent)
        sync_data_bundle(
            manifest_path.parent,
            args.decodable_dir.resolve(),
            data_bundle_path,
        )
        print(f"wrote {target}")
        return 0
    except LeaderboardDataError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
