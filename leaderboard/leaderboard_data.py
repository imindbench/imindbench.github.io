"""Extraction, validation, and serialization for leaderboard model artifacts."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from collections import defaultdict
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 2
MANIFEST_SCHEMA_VERSION = 1
SUBMISSION_SCHEMA_VERSION = 1
CONTRACT_SCHEMA_VERSION = 1
MODEL_ID_RE = re.compile(r"[a-z0-9]+(?:_[a-z0-9]+)*\Z")
SUBJECT_SESSION_RE = re.compile(r"sub(\d+)_(?:sess|trial)(\d+)\Z")
SUBJECT_RE = re.compile(r"sub(\d+)\Z")
KNOWN_DATASETS = {"berezutskayapippi2022", "kelesbyd2024", "neuroprobev2"}
CANONICAL_REGIMES = {"within-session", "cross-session", "cross-subject"}
METRIC_FIELDS = (
    "test_roc_auc",
    "val_roc_auc",
    "train_roc_auc",
    "test_accuracy",
    "val_accuracy",
    "train_accuracy",
)
TASK_ALIASES = {
    "sentence_onset": "onset",
    "word_onset": "onset",
    "word_position": "word_index",
    "word_head": "word_head_pos",
    "head_word_pos": "word_head_pos",
    "head_word_position": "word_head_pos",
}
SUBMISSION_FIELDS = {
    "schema_version",
    "model_id",
    "display_name",
    "pretrained",
    "pretrained_on",
    "description",
    "coverage_note",
}
MODEL_FIELDS = SUBMISSION_FIELDS - {"schema_version"}
RUN_FIELDS = {
    "run_id",
    "run_dir",
    "model_preprocess_key",
    "run_display",
    "preprocessing_name",
    "preprocessing_track",
    "preprocessing_chain",
}
RECORD_FIELDS = {
    "run_id",
    "dataset",
    "subset",
    "eval_mode",
    "task",
    "subject_session",
    "subject_id",
    "session_id",
    "result_session_key",
    "time_window",
    "fold_idx",
    *METRIC_FIELDS,
}


class LeaderboardDataError(ValueError):
    """Raised when input cannot safely be published."""


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def canonicalize_dataset(name: str) -> str:
    if name in KNOWN_DATASETS:
        return name
    base = re.sub(r"_[^_]+$", "", name)
    return base if base in KNOWN_DATASETS else name


def canonicalize_task(task: Any) -> str | None:
    if task is None or str(task).strip() == "":
        return None
    key = str(task).strip().replace(" ", "_").lower()
    return TASK_ALIASES.get(key, key)


def canonicalize_regime(regime: Any) -> str | None:
    if regime is None:
        return None
    return str(regime).strip().lower().replace("_", "-")


def parse_subject_session(value: str | None) -> tuple[int | None, int | None]:
    if not value:
        return None, None
    match = SUBJECT_SESSION_RE.fullmatch(value)
    if match:
        return int(match.group(1)), int(match.group(2))
    match = SUBJECT_RE.fullmatch(value)
    if match:
        return int(match.group(1)), None
    return None, None


def parse_path_metadata(json_path: Path, base_dir: Path) -> dict[str, Any]:
    try:
        parts = json_path.relative_to(base_dir).parts
    except ValueError as exc:
        raise LeaderboardDataError(f"{json_path}: path is outside {base_dir}") from exc
    if len(parts) < 6:
        raise LeaderboardDataError(
            f"{json_path}: expected dataset/run/regime/task/subject/file path"
        )
    regime_idx = next(
        (
            i
            for i, part in enumerate(parts)
            if canonicalize_regime(part) in CANONICAL_REGIMES
        ),
        None,
    )
    if regime_idx not in (2, 3):
        raise LeaderboardDataError(
            f"{json_path}: expected exactly one optional subset directory before the run directory"
        )
    dataset = canonicalize_dataset(parts[0])
    if dataset not in KNOWN_DATASETS:
        raise LeaderboardDataError(f"{json_path}: unknown dataset {parts[0]!r}")
    subject_session = parts[regime_idx + 2]
    subject_id, _ = parse_subject_session(subject_session)
    if subject_id is None:
        raise LeaderboardDataError(
            f"{json_path}: invalid subject/session directory {subject_session!r}"
        )
    return {
        "dataset": dataset,
        "subset": parts[1] if regime_idx == 3 else None,
        "run_dir": parts[regime_idx - 1],
        "eval_mode": canonicalize_regime(parts[regime_idx]),
        "task": canonicalize_task(parts[regime_idx + 1]),
        "subject_session": subject_session,
    }


def make_run_display(run_dir: str) -> str:
    value = re.sub(r"_(?:apr|may)\d+", "", run_dir, flags=re.IGNORECASE)
    value = re.sub(r"_\d{4}-\d{2}-\d{2}|_\d{8}", "", value)
    value = re.sub(r"_\d+Hz", "", value)
    value = re.sub(r"_\d+to\d+", "", value)
    return re.sub(r"_+", "_", value).strip("_")


def make_preprocess_key(run_dir: str) -> str:
    value = re.sub(r"_\d+Hz", "", run_dir)
    value = re.sub(r"_\d+to\d+", "", value)
    return value


def classify_track(name: str, chain: list[dict[str, Any]]) -> str:
    if name in {"laplacian_stft", "laplacian_multi_stft"}:
        return "STFT"
    if name == "laplacian_wav_long_context_15s_diverstyle":
        return "WAV"
    if name.startswith("laplacian_wav") and any(
        step.get("name") == "time_domain_filter"
        and step.get("high_pass_hz") is not None
        for step in chain
    ):
        return "WAV"
    return "Other"


def validate_metric(value: Any, field: str, source: str | Path = "record") -> None:
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise LeaderboardDataError(f"{source}: {field} must be a number or null")
    if not math.isfinite(value) or not 0 <= value <= 1:
        raise LeaderboardDataError(
            f"{source}: {field} must be finite and between 0 and 1"
        )


def validate_submission(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise LeaderboardDataError("submission must be a JSON object")
    unknown = set(data) - SUBMISSION_FIELDS
    missing = {
        "schema_version",
        "model_id",
        "display_name",
        "pretrained",
        "description",
    } - set(data)
    if unknown:
        raise LeaderboardDataError(f"submission has unknown fields: {sorted(unknown)}")
    if missing:
        raise LeaderboardDataError(f"submission is missing fields: {sorted(missing)}")
    if data["schema_version"] != SUBMISSION_SCHEMA_VERSION:
        raise LeaderboardDataError(
            f"unsupported submission schema_version {data['schema_version']!r}"
        )
    model_id = data["model_id"]
    if not isinstance(model_id, str) or not MODEL_ID_RE.fullmatch(model_id):
        raise LeaderboardDataError(
            "model_id must be a stable lowercase underscore-separated slug"
        )
    for field in ("display_name", "description"):
        if not isinstance(data[field], str) or not data[field].strip():
            raise LeaderboardDataError(f"{field} must be a non-empty string")
    if not isinstance(data["pretrained"], bool):
        raise LeaderboardDataError("pretrained must be a boolean")
    pretrained_on = data.get("pretrained_on")
    if data["pretrained"] and (
        not isinstance(pretrained_on, str) or not pretrained_on.strip()
    ):
        raise LeaderboardDataError("pretrained_on is required for pretrained models")
    if not data["pretrained"] and pretrained_on is not None:
        raise LeaderboardDataError(
            "pretrained_on must be null for non-pretrained models"
        )
    coverage_note = data.get("coverage_note")
    if coverage_note is not None and (
        not isinstance(coverage_note, str) or not coverage_note.strip()
    ):
        raise LeaderboardDataError("coverage_note must be a non-empty string or null")
    normalized = {key: data.get(key) for key in SUBMISSION_FIELDS}
    return normalized


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LeaderboardDataError(f"{path}: cannot read valid JSON: {exc}") from exc


def validate_coverage_contract(contract: dict[str, Any]) -> dict[str, Any]:
    if (
        not isinstance(contract, dict)
        or contract.get("schema_version") != CONTRACT_SCHEMA_VERSION
    ):
        raise LeaderboardDataError("unsupported coverage contract schema")
    if set(contract) != {
        "schema_version",
        "evaluation_mode",
        "fold_indices",
        "datasets",
    }:
        raise LeaderboardDataError("coverage contract has invalid top-level fields")
    if canonicalize_regime(contract.get("evaluation_mode")) not in CANONICAL_REGIMES:
        raise LeaderboardDataError("coverage contract has invalid evaluation_mode")
    folds = contract.get("fold_indices")
    if (
        not isinstance(folds, list)
        or not folds
        or any(not isinstance(x, int) for x in folds)
        or len(folds) != len(set(folds))
    ):
        raise LeaderboardDataError(
            "coverage contract fold_indices must be unique integers"
        )
    datasets = contract.get("datasets")
    if not isinstance(datasets, dict) or not datasets:
        raise LeaderboardDataError(
            "coverage contract datasets must be a non-empty object"
        )
    for dataset, spec in datasets.items():
        if dataset not in KNOWN_DATASETS or not isinstance(spec, dict):
            raise LeaderboardDataError(
                f"coverage contract has invalid dataset {dataset!r}"
            )
        if set(spec) != {"subset", "tasks", "subject_sessions"}:
            raise LeaderboardDataError(
                f"coverage contract {dataset} has invalid fields"
            )
        for field in ("tasks", "subject_sessions"):
            values = spec.get(field)
            if (
                not isinstance(values, list)
                or not values
                or len(values) != len(set(values))
            ):
                raise LeaderboardDataError(
                    f"coverage contract {dataset}.{field} must be a unique non-empty list"
                )
        if any(canonicalize_task(task) != task for task in spec["tasks"]):
            raise LeaderboardDataError(
                f"coverage contract {dataset} contains noncanonical tasks"
            )
        if any(parse_subject_session(ss)[0] is None for ss in spec["subject_sessions"]):
            raise LeaderboardDataError(
                f"coverage contract {dataset} contains invalid subject_sessions"
            )
    return contract


def _cross_check(path: Path, label: str, configured: Any, from_path: Any) -> None:
    if configured is not None and configured != from_path:
        raise LeaderboardDataError(
            f"{path}: config {label} {configured!r} contradicts path value {from_path!r}"
        )


def extract_records(
    outputs_dir: Path,
    expected_model_id: str | None = None,
    contract: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    outputs_dir = Path(outputs_dir)
    files = sorted(outputs_dir.rglob("population_*.json"))
    if not files:
        raise LeaderboardDataError(
            f"no population_*.json files found under {outputs_dir}"
        )
    expected_folds = set(contract["fold_indices"]) if contract else None
    records: list[dict[str, Any]] = []
    identities: dict[tuple[Any, ...], Path] = {}
    for path in files:
        data = load_json(path)
        if not isinstance(data, dict):
            raise LeaderboardDataError(f"{path}: result must be a JSON object")
        path_meta = parse_path_metadata(path, outputs_dir)
        config = data.get("config")
        if not isinstance(config, dict):
            raise LeaderboardDataError(f"{path}: missing config object")
        model_id = config.get("model_name") or data.get("model_name")
        if not isinstance(model_id, str) or not MODEL_ID_RE.fullmatch(model_id):
            raise LeaderboardDataError(f"{path}: invalid model ID {model_id!r}")
        if expected_model_id is not None and model_id != expected_model_id:
            raise LeaderboardDataError(
                f"{path}: model ID {model_id!r} does not match {expected_model_id!r}"
            )
        configured_task = canonicalize_task(config.get("eval_name"))
        configured_regime = canonicalize_regime(config.get("splits_type"))
        _cross_check(path, "task", configured_task, path_meta["task"])
        _cross_check(
            path, "evaluation regime", configured_regime, path_meta["eval_mode"]
        )
        subject_id, session_id = parse_subject_session(path_meta["subject_session"])
        cfg_subject = config.get("subject_id")
        cfg_session = config.get("trial_id")
        _cross_check(
            path,
            "subject",
            int(cfg_subject) if cfg_subject is not None else None,
            subject_id,
        )
        _cross_check(
            path,
            "session",
            int(cfg_session) if cfg_session is not None else None,
            session_id,
        )
        preprocess = config.get("preprocess", config.get("preprocessor"))
        if not isinstance(preprocess, dict):
            raise LeaderboardDataError(f"{path}: missing preprocessing configuration")
        preprocess_name = preprocess.get("name")
        chain = preprocess.get("chain")
        if (
            not isinstance(preprocess_name, str)
            or not isinstance(chain, list)
            or any(not isinstance(x, dict) for x in chain)
        ):
            raise LeaderboardDataError(f"{path}: invalid preprocessing name or chain")
        run = {
            "model_id": model_id,
            "run_dir": path_meta["run_dir"],
            "model_preprocess_key": make_preprocess_key(path_meta["run_dir"]),
            "run_display": make_run_display(path_meta["run_dir"]),
            "preprocessing_name": preprocess_name,
            "preprocessing_track": classify_track(preprocess_name, chain),
            "preprocessing_chain": chain,
        }
        run["run_id"] = hashlib.sha256(canonical_json(run).encode("utf-8")).hexdigest()
        evaluation_results = data.get("evaluation_results")
        if not isinstance(evaluation_results, dict) or not evaluation_results:
            raise LeaderboardDataError(
                f"{path}: evaluation_results must be a non-empty object"
            )
        for result_session_key, session_data in evaluation_results.items():
            population = (
                session_data.get("population")
                if isinstance(session_data, dict)
                else None
            )
            if not isinstance(population, dict) or not population:
                raise LeaderboardDataError(
                    f"{path}: population results must be a non-empty object"
                )
            for time_window, time_data in population.items():
                folds = time_data.get("folds") if isinstance(time_data, dict) else None
                if not isinstance(folds, list) or not folds:
                    raise LeaderboardDataError(
                        f"{path}: {time_window} folds must be a non-empty list"
                    )
                fold_indices = [
                    fold.get("fold_idx") for fold in folds if isinstance(fold, dict)
                ]
                if len(fold_indices) != len(folds) or any(
                    not isinstance(x, int) for x in fold_indices
                ):
                    raise LeaderboardDataError(
                        f"{path}: every fold must have an integer fold_idx"
                    )
                if len(fold_indices) != len(set(fold_indices)):
                    raise LeaderboardDataError(f"{path}: duplicate fold_idx values")
                if expected_folds is not None and set(fold_indices) != expected_folds:
                    raise LeaderboardDataError(
                        f"{path}: expected folds {sorted(expected_folds)}, got {sorted(fold_indices)}"
                    )
                for fold in folds:
                    for metric in METRIC_FIELDS:
                        validate_metric(fold.get(metric), metric, path)
                    record = {
                        "model_id": model_id,
                        **run,
                        **path_meta,
                        "subject_id": subject_id,
                        "session_id": session_id,
                        "result_session_key": str(result_session_key),
                        "time_window": str(time_window),
                        "fold_idx": fold["fold_idx"],
                        **{metric: fold.get(metric) for metric in METRIC_FIELDS},
                    }
                    identity = (
                        model_id,
                        path_meta["dataset"],
                        path_meta["subset"],
                        path_meta["eval_mode"],
                        path_meta["task"],
                        path_meta["subject_session"],
                        run["run_id"],
                        str(result_session_key),
                        str(time_window),
                        fold["fold_idx"],
                    )
                    if identity in identities:
                        raise LeaderboardDataError(
                            f"{path}: duplicate record also found in {identities[identity]}"
                        )
                    identities[identity] = path
                    records.append(record)
    return records


def make_run(model_id: str, raw_record: dict[str, Any]) -> dict[str, Any]:
    if raw_record.get("model_id") != model_id:
        raise LeaderboardDataError("record model_id does not match run model_id")
    return {
        key: raw_record[key]
        for key in (
            "run_id",
            "run_dir",
            "model_preprocess_key",
            "run_display",
            "preprocessing_name",
            "preprocessing_track",
            "preprocessing_chain",
        )
    }


def intern_run(model_id: str, raw_record: dict[str, Any]) -> dict[str, Any]:
    return make_run(model_id, raw_record)


def _expected_cells(contract: dict[str, Any]) -> set[tuple[Any, ...]]:
    regime = canonicalize_regime(contract["evaluation_mode"])
    return {
        (dataset, spec.get("subset"), regime, task, subject_session)
        for dataset, spec in contract["datasets"].items()
        for task in spec["tasks"]
        for subject_session in spec["subject_sessions"]
    }


def calculate_coverage(
    runs: list[dict[str, Any]], records: list[dict[str, Any]], contract: dict[str, Any]
) -> dict[str, Any]:
    validate_coverage_contract(contract)
    expected = _expected_cells(contract)
    by_key: dict[str, dict[str, Any]] = {}
    keys = sorted({run["model_preprocess_key"] for run in runs})
    run_lookup = {run["run_id"]: run for run in runs}
    total_observed = total_missing = total_unexpected = 0
    for key in keys:
        cells: set[tuple[Any, ...]] = set()
        cell_folds: dict[tuple[Any, ...], set[int]] = defaultdict(set)
        fold_count = 0
        for record in records:
            run = run_lookup.get(record["run_id"])
            if run is None or run["model_preprocess_key"] != key:
                continue
            cell = (
                record["dataset"],
                record.get("subset"),
                record["eval_mode"],
                record["task"],
                record["subject_session"],
            )
            if record["fold_idx"] in cell_folds[cell]:
                raise LeaderboardDataError(
                    f"logical preprocessing key {key!r} has duplicate fold {record['fold_idx']} for {cell}"
                )
            cells.add(cell)
            cell_folds[cell].add(record["fold_idx"])
            fold_count += 1
        missing = expected - cells
        unexpected = cells - expected
        missing_by_dataset = {
            dataset: sum(1 for cell in missing if cell[0] == dataset)
            for dataset in sorted(contract["datasets"])
        }
        item = {
            "status": "complete" if not missing and not unexpected else "partial",
            "expected_result_cells": len(expected),
            "observed_result_cells": len(cells),
            "missing_result_cells": len(missing),
            "unexpected_result_cells": len(unexpected),
            "fold_records": fold_count,
            "missing_by_dataset": missing_by_dataset,
        }
        by_key[key] = item
        total_observed += len(cells)
        total_missing += len(missing)
        total_unexpected += len(unexpected)
    return {
        "status": (
            "complete" if total_missing == 0 and total_unexpected == 0 else "partial"
        ),
        "expected_result_cells": len(expected) * len(keys),
        "observed_result_cells": total_observed,
        "missing_result_cells": total_missing,
        "unexpected_result_cells": total_unexpected,
        "by_model_preprocess_key": by_key,
    }


def describe_unexpected_result_cells(
    runs: list[dict[str, Any]], records: list[dict[str, Any]], contract: dict[str, Any]
) -> str:
    """Return actionable details for result cells outside the coverage contract."""
    expected = _expected_cells(contract)
    run_lookup = {run["run_id"]: run for run in runs}
    unexpected: set[tuple[Any, ...]] = set()
    for record in records:
        run = run_lookup.get(record["run_id"])
        if run is None:
            continue
        cell = (
            record["dataset"],
            record.get("subset"),
            record["eval_mode"],
            record["task"],
            record["subject_session"],
        )
        if cell not in expected:
            unexpected.add((run["model_preprocess_key"], *cell))

    grouped: dict[tuple[Any, Any], int] = defaultdict(int)
    for _, dataset, subset, *_ in unexpected:
        grouped[(dataset, subset)] += 1

    details = []
    path_hints = []
    for (dataset, subset), count in sorted(
        grouped.items(), key=lambda item: repr(item[0])
    ):
        expected_subset = contract["datasets"].get(dataset, {}).get("subset")
        if dataset in contract["datasets"] and subset != expected_subset:
            details.append(
                f"{dataset} has subset {subset!r}, but the contract expects "
                f"{expected_subset!r} ({count} cells)"
            )
            if subset is None and expected_subset is not None:
                path_hints.append(
                    f"place its results under {dataset}/{expected_subset}/<run>/..."
                )
        else:
            details.append(f"{dataset} subset {subset!r} ({count} cells)")

    message = "; ".join(details)
    if path_hints:
        message += ". Path hint: " + "; ".join(path_hints)
    if unexpected and not details:
        sample = sorted(unexpected, key=repr)[0]
        message = f"example unexpected cell: {sample!r}"
    return message


def _record_for_artifact(raw_record: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "run_id",
        "dataset",
        "subset",
        "eval_mode",
        "task",
        "subject_session",
        "subject_id",
        "session_id",
        "result_session_key",
        "time_window",
        "fold_idx",
        *METRIC_FIELDS,
    )
    return {field: raw_record[field] for field in fields}


def build_artifact(
    submission: dict[str, Any],
    extracted_records: list[dict[str, Any]],
    contract: dict[str, Any],
) -> dict[str, Any]:
    submission = validate_submission(submission)
    model_id = submission["model_id"]
    if not extracted_records:
        raise LeaderboardDataError("cannot build an artifact without records")
    if {record.get("model_id") for record in extracted_records} != {model_id}:
        raise LeaderboardDataError(
            "extracted records do not all match submission model_id"
        )
    runs_by_id: dict[str, dict[str, Any]] = {}
    for raw in extracted_records:
        run = make_run(model_id, raw)
        previous = runs_by_id.setdefault(run["run_id"], run)
        if previous != run:
            raise LeaderboardDataError(f"run ID collision for {run['run_id']}")
    runs = sorted(runs_by_id.values(), key=lambda run: (run["run_id"], run["run_dir"]))
    records = sorted(
        (_record_for_artifact(record) for record in extracted_records),
        key=lambda r: (
            r["dataset"],
            r["subset"] or "",
            r["eval_mode"],
            r["task"],
            r["subject_session"],
            r["run_id"],
            r["result_session_key"],
            r["time_window"],
            r["fold_idx"],
        ),
    )
    model = {field: submission.get(field) for field in sorted(MODEL_FIELDS)}
    artifact = {
        "schema_version": SCHEMA_VERSION,
        "model": model,
        "coverage": calculate_coverage(runs, records, contract),
        "runs": runs,
        "records": records,
    }
    validate_artifact(artifact, contract)
    return artifact


def validate_artifact(artifact: dict[str, Any], contract: dict[str, Any]) -> None:
    if not isinstance(artifact, dict) or set(artifact) != {
        "schema_version",
        "model",
        "coverage",
        "runs",
        "records",
    }:
        raise LeaderboardDataError("artifact has invalid top-level fields")
    if artifact["schema_version"] != SCHEMA_VERSION:
        raise LeaderboardDataError("unsupported artifact schema_version")
    submission = {"schema_version": SUBMISSION_SCHEMA_VERSION, **artifact["model"]}
    validate_submission(submission)
    runs = artifact["runs"]
    records = artifact["records"]
    if (
        not isinstance(runs, list)
        or not runs
        or not isinstance(records, list)
        or not records
    ):
        raise LeaderboardDataError("artifact runs and records must be non-empty lists")
    run_ids = [run.get("run_id") for run in runs]
    if len(run_ids) != len(set(run_ids)):
        raise LeaderboardDataError("artifact contains duplicate run IDs")
    run_id_set = set(run_ids)
    for run in runs:
        if not isinstance(run, dict) or set(run) != RUN_FIELDS:
            raise LeaderboardDataError("artifact run has invalid fields")
        if not isinstance(run["run_id"], str) or not run["run_id"]:
            raise LeaderboardDataError("artifact run_id must be a non-empty string")
        if run["preprocessing_track"] not in {"STFT", "WAV", "Other"}:
            raise LeaderboardDataError("artifact run has invalid preprocessing_track")
    identities = set()
    folds_by_result: dict[tuple[Any, ...], set[int]] = defaultdict(set)
    for record in records:
        if not isinstance(record, dict) or set(record) != RECORD_FIELDS:
            raise LeaderboardDataError("artifact record has invalid fields")
        if record.get("run_id") not in run_id_set:
            raise LeaderboardDataError(
                f"record references unknown run {record.get('run_id')!r}"
            )
        for metric in METRIC_FIELDS:
            validate_metric(record.get(metric), metric, "artifact record")
        if not isinstance(record.get("fold_idx"), int) or isinstance(
            record.get("fold_idx"), bool
        ):
            raise LeaderboardDataError("artifact fold_idx must be an integer")
        identity = tuple(
            record.get(field)
            for field in (
                "dataset",
                "subset",
                "eval_mode",
                "task",
                "subject_session",
                "run_id",
                "result_session_key",
                "time_window",
                "fold_idx",
            )
        )
        if identity in identities:
            raise LeaderboardDataError(
                f"artifact contains duplicate record identity {identity}"
            )
        identities.add(identity)
        result_identity = identity[:-1]
        folds_by_result[result_identity].add(record.get("fold_idx"))
    expected_folds = set(contract["fold_indices"])
    incomplete = [
        identity
        for identity, folds in folds_by_result.items()
        if folds != expected_folds
    ]
    if incomplete:
        raise LeaderboardDataError(
            f"artifact result {incomplete[0]} has folds {sorted(folds_by_result[incomplete[0]])}, "
            f"expected {sorted(expected_folds)}"
        )
    unused = run_id_set - {record["run_id"] for record in records}
    if unused:
        raise LeaderboardDataError(f"artifact contains unused runs: {sorted(unused)}")
    calculated = calculate_coverage(runs, records, contract)
    if calculated["unexpected_result_cells"]:
        details = describe_unexpected_result_cells(runs, records, contract)
        raise LeaderboardDataError(
            f"artifact contains {calculated['unexpected_result_cells']} unexpected benchmark result cells: "
            f"{details}"
        )
    if artifact["coverage"] != calculated:
        raise LeaderboardDataError("stored artifact coverage does not match records")


def make_manifest(
    model_ids: list[str], unpublished_model_ids: list[str] | None = None
) -> dict[str, Any]:
    if len(model_ids) != len(set(model_ids)):
        raise LeaderboardDataError("duplicate model IDs in manifest input")
    unpublished = set(unpublished_model_ids or [])
    unknown = unpublished - set(model_ids)
    if unknown:
        raise LeaderboardDataError(
            f"unpublished model IDs are absent from manifest input: {sorted(unknown)}"
        )
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "models": [
            f"models/{model_id}.json"
            for model_id in sorted(set(model_ids) - unpublished)
        ],
    }
    if unpublished:
        manifest["unpublished_models"] = [
            f"models/{model_id}.json" for model_id in sorted(unpublished)
        ]
    return manifest


def manifest_model_paths(manifest: dict[str, Any]) -> list[str]:
    allowed_fields = {"schema_version", "models", "unpublished_models"}
    if (
        not isinstance(manifest, dict)
        or not {
            "schema_version",
            "models",
        }
        <= set(manifest)
        or not set(manifest) <= allowed_fields
    ):
        raise LeaderboardDataError("manifest has invalid fields")
    visible = manifest["models"]
    unpublished = manifest.get("unpublished_models", [])
    for field, paths in (("models", visible), ("unpublished_models", unpublished)):
        if (
            not isinstance(paths, list)
            or paths != sorted(paths)
            or len(paths) != len(set(paths))
        ):
            raise LeaderboardDataError(
                f"manifest {field} paths must be unique and sorted"
            )
    overlap = set(visible) & set(unpublished)
    if overlap:
        raise LeaderboardDataError(
            f"manifest paths cannot be both visible and unpublished: {sorted(overlap)}"
        )
    return visible + unpublished


def validate_manifest(manifest: dict[str, Any], data_dir: Path) -> None:
    paths = manifest_model_paths(manifest)
    if manifest["schema_version"] != MANIFEST_SCHEMA_VERSION:
        raise LeaderboardDataError("unsupported manifest schema_version")
    data_dir = Path(data_dir).resolve()
    listed: set[Path] = set()
    model_ids = set()
    for relative in paths:
        if not isinstance(relative, str):
            raise LeaderboardDataError("manifest paths must be strings")
        rel = Path(relative)
        if (
            rel.is_absolute()
            or rel.parts[:1] != ("models",)
            or ".." in rel.parts
            or rel.suffix != ".json"
        ):
            raise LeaderboardDataError(f"unsafe manifest path {relative!r}")
        path = (data_dir / rel).resolve()
        if data_dir not in path.parents or not path.is_file():
            raise LeaderboardDataError(f"manifest file does not exist: {relative}")
        artifact = load_json(path)
        model_id = artifact.get("model", {}).get("model_id")
        if model_id != rel.stem:
            raise LeaderboardDataError(
                f"{relative}: filename does not match model_id {model_id!r}"
            )
        if model_id in model_ids:
            raise LeaderboardDataError(f"duplicate model ID {model_id!r}")
        model_ids.add(model_id)
        listed.add(path)
    actual = {path.resolve() for path in (data_dir / "models").glob("*.json")}
    if listed != actual:
        missing = sorted(str(path.relative_to(data_dir)) for path in actual - listed)
        extra = sorted(str(path.relative_to(data_dir)) for path in listed - actual)
        raise LeaderboardDataError(
            f"manifest/model directory mismatch; unlisted={missing}, missing={extra}"
        )


def json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")


def atomic_write(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def transactional_write(changes: dict[Path, bytes]) -> None:
    """Apply prepared file changes and restore prior bytes on a handled failure."""
    originals = {path: path.read_bytes() if path.exists() else None for path in changes}
    written: list[Path] = []
    try:
        for path, content in changes.items():
            atomic_write(path, content)
            written.append(path)
    except Exception:
        for path in reversed(written):
            original = originals[path]
            if original is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write(path, original)
        raise


def summarize_artifact(artifact: dict[str, Any]) -> dict[str, Any]:
    records = artifact["records"]
    runs = artifact["runs"]
    return {
        "model_id": artifact["model"]["model_id"],
        "runs": len(runs),
        "logical_entries": len({run["model_preprocess_key"] for run in runs}),
        "records": len(records),
        "datasets": sorted({record["dataset"] for record in records}),
        "tasks": sorted({record["task"] for record in records}),
        "coverage": artifact["coverage"],
    }
