"""Track eligibility and the public result-to-submission workflow."""

from copy import deepcopy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


LEADERBOARD = Path(__file__).resolve().parents[1] / "leaderboard"
sys.path.insert(0, str(LEADERBOARD))

from leaderboard_data import (  # noqa: E402
    DEFAULT_DECODABLE_DIR,
    LeaderboardDataError,
    METRIC_FIELDS,
    extract_records,
    load_cohort_cells,
    load_json,
    parse_subject_session,
    validate_artifact,
)
from preprocessing_tracks import classify_preprocessing  # noqa: E402


def published_chain(model, track, sampling_rate=None):
    artifact = load_json(LEADERBOARD / "data/models" / f"{model}.json")
    return deepcopy(
        next(
            run["preprocessing_chain"]
            for run in artifact["runs"]
            if run["preprocessing_track"] == track
            and (
                sampling_rate is None
                or any(
                    stage.get("sampling_rate") == sampling_rate
                    for stage in run["preprocessing_chain"]
                )
            )
        )
    )


def public_result(chain, task="speech", subject_session="sub1_sess1", name=None):
    subject, session = parse_subject_session(subject_session)
    preprocess = {"chain": chain}
    if name is not None:
        preprocess["name"] = name
    # Match build_public_export_result's nesting, including two complete folds.
    return {
        "model_name": "test_model",
        "author": "Test",
        "organization": "Test",
        "config": {
            "model_name": "test_model",
            "preprocess": preprocess,
            "eval_name": task,
            "splits_type": "within-session",
            "subject_id": subject,
            "trial_id": session,
        },
        "evaluation_results": {
            subject_session: {
                "population": {
                    "0.0_0.5": {
                        "folds": [
                            {
                                "fold_idx": index,
                                **{field: 0.7 for field in METRIC_FIELDS},
                            }
                            for index in (0, 1)
                        ]
                    }
                }
            }
        },
    }


def write_json(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


class TrackClassificationTests(unittest.TestCase):
    def assert_track(self, chain, expected):
        before = deepcopy(chain)
        track, reason = classify_preprocessing(chain)
        self.assertEqual(track, expected)
        self.assertIsInstance(reason, str)
        self.assertTrue(reason.strip())
        self.assertEqual(chain, before, "classification must not mutate the config")

    def test_paper_multi_stft_at_both_sampling_rates(self):
        for rate in (1000, 2048):
            with self.subTest(rate=rate):
                self.assert_track(published_chain("cnn", "STFT", rate), "STFT")

    def test_explicit_defaults_match_legacy_multi_stft(self):
        chain = published_chain("cnn", "STFT", 1000)
        chain[0].update(high_pass_hz=0.0, notch_freqs=[60, 120, 180, 240, 300, 360])
        self.assert_track(chain, "STFT")

    def test_multi_stft_parameter_boundaries(self):
        for field, value in (
            ("hop_length", 63),
            ("window", "hamming"),
            ("normalizing", "zscore"),
        ):
            with self.subTest(field=field):
                chain = published_chain("cnn", "STFT", 1000)
                chain[2][field] = value
                self.assert_track(chain, "Other")
        for field, value in (
            ("nperseg", 499),
            ("min_frequency", 1),
            ("max_frequency", 41),
        ):
            with self.subTest(window_field=field):
                chain = published_chain("cnn", "STFT", 1000)
                chain[2]["windows"][0][field] = value
                self.assert_track(chain, "Other")

    def test_multi_stft_requires_pooled_normalization_and_order(self):
        chain = published_chain("cnn", "STFT")
        chain[-1]["mode"] = "sample_per_channel_time"
        self.assert_track(chain, "Other")
        chain = published_chain("cnn", "STFT")
        chain[0], chain[1] = chain[1], chain[0]
        self.assert_track(chain, "Other")

    def test_multi_stft_filtering_and_reference_boundaries(self):
        for index, field, value in (
            (0, "high_pass_hz", 0.5),
            (0, "high_gamma", True),
            (0, "notch_freqs", []),
            (1, "remove_non_laplacian", False),
        ):
            with self.subTest(field=field):
                chain = published_chain("cnn", "STFT")
                chain[index][field] = value
                self.assert_track(chain, "Other")

    def test_multi_stft_per_window_overrides_are_checked(self):
        for field, value in (
            ("sampling_rate", 2048),
            ("window", "hamming"),
            ("normalizing", "zscore"),
            ("clip_k", 3),
        ):
            with self.subTest(field=field):
                chain = published_chain("cnn", "STFT", 1000)
                chain[2]["windows"][0][field] = value
                self.assert_track(chain, "Other")

    def test_published_waveform_variants(self):
        for model in ("logistic", "barista", "diver"):
            with self.subTest(model=model):
                self.assert_track(published_chain(model, "WAV"), "WAV")

    def test_waveform_current_resampling_and_normalization(self):
        chain = published_chain("logistic", "WAV")
        chain[-2]["name"] = "resample"
        chain[-1]["mode"] = "sample_per_channel_time"
        self.assert_track(chain, "WAV")

    def test_diver_omitted_null_and_explicit_high_pass(self):
        chain = published_chain("diver", "WAV")
        self.assert_track(chain, "WAV")
        for value, expected in (
            (None, "WAV"),
            (0.5, "WAV"),
            (0.0, "Other"),
            (1.0, "Other"),
        ):
            with self.subTest(value=value):
                chain[1]["high_pass_hz"] = value
                self.assert_track(chain, expected)

    def test_waveform_requires_high_pass_notch_and_reference(self):
        for field, value in (
            ("high_pass_hz", 0.0),
            ("high_pass_hz", 1.0),
            ("notch_freqs", []),
            ("high_gamma", True),
        ):
            with self.subTest(field=field, value=value):
                chain = published_chain("logistic", "WAV")
                chain[1][field] = value
                self.assert_track(chain, "Other")
        chain = published_chain("logistic", "WAV")
        del chain[1]["high_pass_hz"]
        self.assert_track(chain, "Other")
        chain = published_chain("logistic", "WAV")
        del chain[3]
        self.assert_track(chain, "Other")

    def test_unknown_and_spectral_transforms_are_custom(self):
        for name in ("unknown_transform", "stft"):
            with self.subTest(name=name):
                chain = published_chain("logistic", "WAV")
                chain.append({"name": name})
                self.assert_track(chain, "Other")

    def test_unknown_settings_cannot_silently_qualify(self):
        chain = published_chain("logistic", "WAV")
        chain[1]["unreviewed_filter_option"] = True
        self.assert_track(chain, "Other")

    def test_waveform_sampling_and_order_must_be_consistent(self):
        chain = published_chain("logistic", "WAV", 1000)
        chain[-2]["source_rate"] = 2048
        self.assert_track(chain, "Other")
        chain = published_chain("logistic", "WAV")
        chain[-2], chain[-1] = chain[-1], chain[-2]
        self.assert_track(chain, "Other")

    def test_malformed_multi_stft_windows_fail(self):
        for windows in (None, {}, [None]):
            with self.subTest(windows=windows):
                chain = published_chain("cnn", "STFT")
                chain[2]["windows"] = windows
                with self.assertRaises(ValueError):
                    classify_preprocessing(chain)

    def test_filter_and_normalization_review_regressions(self):
        for value in (0, 4.0):
            with self.subTest(high_pass_order=value):
                chain = published_chain("logistic", "WAV")
                chain[1]["high_pass_order"] = value
                with self.assertRaises(ValueError):
                    classify_preprocessing(chain)
        for field in ("notch_zero_phase", "high_pass_zero_phase"):
            with self.subTest(field=field):
                chain = published_chain("barista", "WAV")
                chain[0][field] = False
                with self.assertRaises(ValueError):
                    classify_preprocessing(chain)
        for value in ([], None, 42):
            chain = published_chain("logistic", "WAV")
            chain[-1]["mode"] = value
            with self.subTest(mode=value), self.assertRaises(ValueError):
                classify_preprocessing(chain)
        for value in (float("inf"), float("nan"), -1):
            chain = published_chain("cnn", "STFT")
            chain[-1]["eps"] = value
            with self.subTest(eps=value), self.assertRaises(ValueError):
                classify_preprocessing(chain)
        chain = published_chain("cnn", "STFT")
        chain[-1]["eps"] = 1e20
        self.assert_track(chain, "Other")
        chain = published_chain("logistic", "WAV")
        chain[-1].update(robust_reservoir_size=1000000, robust_random_seed=0, eps=1e-8)
        self.assert_track(chain, "WAV")

    def test_explicit_context_and_spectral_defaults(self):
        chain = published_chain("logistic", "WAV")
        chain[0].update(pad_mode="reflect", crop_back=True, alignment="center")
        self.assert_track(chain, "WAV")
        del chain[0]["sampling_rate"]
        with self.assertRaises(ValueError):
            classify_preprocessing(chain)
        chain = published_chain("cnn", "STFT")
        chain[2].update(torch_dtype="float32", freq_channel_cutoff=0)
        self.assert_track(chain, "STFT")
        chain[2]["windows"][0]["freq_channel_cutoff"] = 40
        self.assert_track(chain, "Other")

    def test_sample_counts_require_integer_types(self):
        chain = published_chain("cnn", "STFT")
        chain[2]["hop_length"] = float(chain[2]["hop_length"])
        with self.assertRaises(ValueError):
            classify_preprocessing(chain)
        chain = published_chain("logistic", "WAV")
        chain[-2]["target_rate"] = 500.0
        with self.assertRaises(ValueError):
            classify_preprocessing(chain)

    def test_malformed_chains_fail(self):
        for chain in (
            None,
            {},
            [],
            [None],
            [{}],
            [{"name": None}],
            [{"name": 42}],
            [{"name": ""}],
        ):
            with self.subTest(chain=chain), self.assertRaises(ValueError):
                classify_preprocessing(chain)

    def test_malformed_filter_parameters_fail(self):
        for field, value in (
            ("high_pass_hz", None),
            ("high_pass_hz", "0.5"),
            ("high_pass_hz", True),
            ("high_pass_hz", -1),
            ("high_pass_hz", float("nan")),
            ("sampling_rate", "1000"),
            ("notch_freqs", "60,120"),
            ("notch_freqs", [True]),
            ("notch_freqs", [-60]),
        ):
            with self.subTest(field=field, value=value):
                chain = published_chain("logistic", "WAV")
                chain[1][field] = value
                with self.assertRaises(ValueError):
                    classify_preprocessing(chain)


class SubmissionWorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.contract = load_json(LEADERBOARD / "data/coverage_contract.json")
        cls.cohorts = load_cohort_cells(DEFAULT_DECODABLE_DIR, cls.contract)

    def run_cli(self, script, *args):
        completed = subprocess.run(
            [sys.executable, str(LEADERBOARD / script), *map(str, args)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        return completed.stdout

    def test_unnamed_current_and_misleading_historical_names(self):
        chain = published_chain("logistic", "WAV")
        for name in (None, "laplacian_multi_stft", "arbitrary_display_label"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                path = (
                    base
                    / "neuroprobev2/model_STFT/within-session/speech/sub1_sess1/population_1.json"
                )
                write_json(path, public_result(chain, name=name))
                records = extract_records(base, "test_model", self.contract)
                self.assertEqual(len(records), 2)
                self.assertEqual(
                    {record["preprocessing_track"] for record in records}, {"WAV"}
                )
                self.assertEqual(records[0]["preprocessing_chain"], chain)

    def test_importer_reports_malformed_chain_as_data_error(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            path = (
                base
                / "neuroprobev2/model/within-session/speech/sub1_sess1/population_1.json"
            )
            write_json(path, public_result([{"name": None}]))
            with self.assertRaises(LeaderboardDataError):
                extract_records(base, "test_model", self.contract)

    def test_artifact_validation_rejects_forged_track(self):
        artifact = load_json(LEADERBOARD / "data/models/logistic.json")
        artifact["runs"][0]["preprocessing_track"] = "Other"
        with self.assertRaisesRegex(LeaderboardDataError, "track"):
            validate_artifact(artifact, self.contract, self.cohorts)

    def test_one_displayed_row_cannot_mix_tracks(self):
        artifact = load_json(LEADERBOARD / "data/models/logistic.json")
        run = next(r for r in artifact["runs"] if r["preprocessing_track"] == "STFT")
        run["preprocessing_chain"][-1]["mode"] = "sample_per_channel_time"
        run["preprocessing_track"] = "Other"
        with self.assertRaisesRegex(LeaderboardDataError, "mixes tracks"):
            validate_artifact(artifact, self.contract, self.cohorts)

    def test_all_published_artifacts_and_bundle_validate(self):
        output = self.run_cli("validate_data.py")
        manifest = load_json(LEADERBOARD / "data/manifest.json")
        expected = len(manifest["models"]) + len(manifest.get("unpublished_models", []))
        self.assertIn(f"validated {expected} model artifacts", output)

    def test_full_benchmark_dry_run_apply_and_validation(self):
        chain = published_chain("cnn", "STFT", 1000)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outputs = root / "outputs"
            data_dir = root / "data"
            metadata_path = data_dir / "submissions/test_model.json"
            write_json(
                metadata_path,
                {
                    "schema_version": 1,
                    "model_id": "test_model",
                    "display_name": "Synthetic integration fixture",
                    "pretrained": False,
                    "description": "Generated test scores; never published.",
                },
            )
            shutil.copyfile(
                LEADERBOARD / "data/coverage_contract.json",
                data_dir / "coverage_contract.json",
            )
            for dataset, spec in self.contract["datasets"].items():
                dataset_dir = outputs / dataset
                if spec["subset"]:
                    dataset_dir /= spec["subset"]
                for task in spec["tasks"]:
                    for subject_session in spec["subject_sessions"]:
                        path = (
                            dataset_dir
                            / "test_model_multi_stft"
                            / "within-session"
                            / task
                            / subject_session
                            / "population_test.json"
                        )
                        write_json(path, public_result(chain, task, subject_session))
            arguments = (
                "--model-outputs",
                outputs,
                "--submission",
                metadata_path,
                "--models-dir",
                data_dir / "models",
                "--manifest",
                data_dir / "manifest.json",
                "--coverage-contract",
                data_dir / "coverage_contract.json",
            )
            output = self.run_cli("add_model.py", *arguments, "--dry-run")
            self.assertIn("cohort: full", output)
            self.assertIn("dry-run:", output)
            self.assertFalse((data_dir / "models/test_model.json").exists())
            self.run_cli("add_model.py", *arguments)
            artifact = load_json(data_dir / "models/test_model.json")
            self.assertEqual(
                {run["preprocessing_track"] for run in artifact["runs"]}, {"STFT"}
            )
            expected_records = (
                sum(
                    len(spec["tasks"]) * len(spec["subject_sessions"])
                    for spec in self.contract["datasets"].values()
                )
                * 2
            )
            self.assertEqual(len(artifact["records"]), expected_records)
            self.run_cli(
                "validate_data.py",
                "--data-dir",
                data_dir,
                "--submissions-dir",
                data_dir / "submissions",
            )
            self.assertIn("unchanged", self.run_cli("add_model.py", *arguments))


if __name__ == "__main__":
    unittest.main()
