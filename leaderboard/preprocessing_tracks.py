"""Paper-defined track eligibility from preprocessing stages, not recipe names.

Track IDs remain STFT/WAV/Other for existing artifacts and browser URLs.
Other is displayed as Custom. Defaults here describe supported historical
implementations; unknown stages/settings require review as a custom route.
"""

from __future__ import annotations

import math


STANDARD_NOTCHES = [60, 120, 180, 240, 300, 360]
DIVER_NOTCHES = [60, 120, 180]
NORMALIZATION_MODES = {
    "global_feature",
    "global_scalar",
    "global_robust_scalar",
    "per_channel_feature",
    "per_channel_samples_time_pooled",
    "sample_per_channel_time",
}
STAGE_FIELDS = {
    "time_domain_filter": {
        "sampling_rate",
        "high_gamma",
        "high_pass_hz",
        "high_pass_order",
        "high_pass_zero_phase",
        "notch_freqs",
        "notch_q",
        "notch_zero_phase",
        "session_wise",
        "use_sos_notch_cascade",
        "bandpass_q",
        "bandpass_low",
        "bandpass_high",
        "filter_cache_enabled",
        "filter_cache_dir",
        "filter_cache_mode",
    },
    "time_domain_filter_diver_style": {"sampling_rate", "notch_freqs", "high_pass_hz"},
    "laplacian_rereference": {"remove_non_laplacian"},
    "context_window": {
        "sampling_rate",
        "context_window_sec",
        "pad_mode",
        "crop_back",
        "alignment",
        "trailing_segment_sec",
    },
    "crop_to_target_window": set(),
    "resample": {"source_rate", "target_rate"},
    "downsample": {"source_rate", "target_rate"},
    "upsampler": {"source_rate", "target_rate"},
    "standardize": {
        "mode",
        "eps",
        "unseen_channel_policy",
        "robust_reservoir_size",
        "robust_random_seed",
    },
    "multi_stft": {
        "sampling_rate",
        "hop_length",
        "windows",
        "normalizing",
        "window",
        "pad_mode",
        "padded",
        "clip_k",
        "freq_channel_cutoff",
        "torch_dtype",
    },
}


def _number(stage, key, default=None):
    value = stage.get(key, default)
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise ValueError(f"{stage['name']}.{key} must be a finite number")
    return value


def _flag(stage, key, default=False):
    value = stage.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{stage['name']}.{key} must be a boolean")
    return value


def _integer(stage, key, default=None):
    value = stage.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{stage['name']}.{key} must be a positive integer")
    return value


def _filter_settings(stage):
    rate = _number(stage, "sampling_rate", 2048)
    if rate <= 0:
        raise ValueError("filter sampling_rate must be positive")
    diver = stage["name"] == "time_domain_filter_diver_style"
    # Only DIVER treats explicit null as its historical 0.5 Hz default.
    if diver and stage.get("high_pass_hz") is None:
        high_pass = 0.5
    else:
        high_pass = _number(stage, "high_pass_hz", 0.0)
    if not 0 <= high_pass < rate / 2:
        raise ValueError("filter high_pass_hz must be nonnegative and below Nyquist")
    notches = stage.get("notch_freqs", DIVER_NOTCHES if diver else STANDARD_NOTCHES)
    if not isinstance(notches, list) or any(
        isinstance(f, bool)
        or not isinstance(f, (int, float))
        or not math.isfinite(f)
        or f <= 0
        for f in notches
    ):
        raise ValueError(
            "filter notch_freqs must be a list of positive finite frequencies"
        )
    if len(set(notches)) != len(notches):
        raise ValueError("filter notch_freqs must not contain duplicates")
    # Standard filtering skips notches at/above Nyquist; DIVER's MNE path does not.
    if diver and any(f >= rate / 2 for f in notches):
        raise ValueError("DIVER notch frequencies must be below Nyquist")
    effective = [f for f in notches if f < rate / 2]
    expected = [
        f for f in (DIVER_NOTCHES if diver else STANDARD_NOTCHES) if f < rate / 2
    ]
    notch_matches = sorted(effective) == expected and bool(expected)
    if not diver:
        if high_pass > 0:
            _integer(stage, "high_pass_order", 4)
        for key in (
            "notch_zero_phase",
            "high_pass_zero_phase",
            "session_wise",
            "use_sos_notch_cascade",
        ):
            _flag(
                stage,
                key,
                stage.get("notch_zero_phase", False)
                if key == "high_pass_zero_phase"
                else False,
            )
        if _number(stage, "notch_q", 30) <= 0:
            raise ValueError("time_domain_filter.notch_q must be positive")
        if stage.get("session_wise", False) and (
            not stage.get("notch_zero_phase", False)
            or (
                high_pass > 0
                and not stage.get(
                    "high_pass_zero_phase", stage.get("notch_zero_phase", False)
                )
            )
        ):
            raise ValueError(
                "Session-wise filtering requires zero-phase notch and high-pass filters"
            )
    return rate, high_pass, notch_matches


def _spectral_reason(chain):
    if [s["name"] for s in chain] != [
        "time_domain_filter",
        "laplacian_rereference",
        "multi_stft",
        "standardize",
    ]:
        return "Multi-STFT requires filter → Laplacian → multi_stft → training normalization"
    filtering, reference, spectral, normalization = chain
    rate, high_pass, notch_matches = _filter_settings(filtering)
    if not notch_matches or high_pass != 0 or _flag(filtering, "high_gamma"):
        return "Multi-STFT requires standard harmonic notches without high-pass or high-gamma filtering"
    if _flag(filtering, "session_wise") or _flag(filtering, "notch_zero_phase"):
        return "Multi-STFT requires the benchmark per-window causal notch filtering"
    if _number(filtering, "notch_q", 30) != 30:
        return "Multi-STFT requires notch_q=30"
    if not _flag(reference, "remove_non_laplacian"):
        return "Multi-STFT requires removal of non-Laplacian channels"
    if rate not in (1000, 2048) or _number(spectral, "sampling_rate", 2048) != rate:
        return "Multi-STFT requires matched filter/STFT rates of 1000 or 2048 Hz"
    expected_hop = 62 if rate == 1000 else 128
    if _integer(spectral, "hop_length") != expected_hop:
        return f"Multi-STFT requires hop_length={expected_hop} at {rate:g} Hz"
    windows = spectral.get("windows")
    if not isinstance(windows, list) or any(not isinstance(w, dict) for w in windows):
        raise ValueError("multi_stft.windows must be a list of mappings")
    if len(windows) != 3:
        return "Multi-STFT requires exactly three frequency windows"
    for window, duration, low, high in zip(
        windows, (0.5, 0.25, 0.125), (2, 20, 80), (40, 150, 250)
    ):
        if set(window) - {
            "label",
            "nperseg",
            "min_frequency",
            "max_frequency",
            "sampling_rate",
            "window",
            "normalizing",
            "pad_mode",
            "padded",
            "clip_k",
            "freq_channel_cutoff",
            "torch_dtype",
        }:
            return "Multi-STFT window has unsupported settings"
        # Per-window options override top-level defaults in the evaluator.
        effective = {**spectral, **window}
        if (
            _integer(effective, "nperseg") != rate * duration
            or _number(effective, "min_frequency") != low
            or _number(effective, "max_frequency") != high
            or _number(effective, "sampling_rate", 2048) != rate
        ):
            return (
                "Multi-STFT requires the paper's ordered durations and frequency bands"
            )
        if (
            effective.get("window", "hann") != "hann"
            or effective.get("normalizing", "none") not in (None, "none")
            or effective.get("pad_mode", "reflect") != "reflect"
            or _flag(effective, "padded")
            or _number(effective, "clip_k", 0) != 0
            or _number(effective, "freq_channel_cutoff", 0) != 0
            or effective.get("torch_dtype", "float32") not in (None, "float32")
        ):
            return "Multi-STFT requires Hann windows, reflection padding, and no extra normalization or clipping"
    if (
        normalization.get("mode", "per_channel_feature")
        != "per_channel_samples_time_pooled"
    ):
        return "Multi-STFT requires training-fitted per-channel/frequency pooled normalization"
    if _number(normalization, "eps", 1e-8) != 1e-8:
        return "The canonical Multi-STFT normalization uses eps=1e-8"
    return None


def _waveform_reason(chain):
    names = [s["name"] for s in chain]
    filters = [
        s
        for s in chain
        if s["name"] in {"time_domain_filter", "time_domain_filter_diver_style"}
    ]
    if len(filters) != 1 or names.count("laplacian_rereference") != 1:
        return "Waveform requires one filter stage and one Laplacian rereference stage"
    filtering = filters[0]
    rate, high_pass, notch_matches = _filter_settings(filtering)
    if high_pass != 0.5:
        return "Waveform requires a 0.5 Hz high-pass filter"
    if not notch_matches or _flag(filtering, "high_gamma"):
        return (
            "Waveform requires supported line-noise notches and no high-gamma bandpass"
        )
    # Filter/crop first, then rereference/resample, then normalize. Sampling and
    # normalization may vary, but spectral/unknown transforms are never waved through.
    index = 0
    if names[0] == "context_window":
        context = chain[0]
        if _number(context, "context_window_sec") <= 0:
            raise ValueError("context_window_sec must be positive")
        if _number(context, "sampling_rate") != rate:
            return "Context and filter sampling rates differ"
        if (
            context.get("pad_mode", "reflect") != "reflect"
            or not _flag(context, "crop_back", True)
            or context.get("alignment", "center") != "center"
        ):
            return "Supported waveform context uses reflection padding, centered placement, and target-window cropping"
        if _flag(filtering, "session_wise"):
            return "Context-window and session-wise filtering cannot be combined"
        index += 1
    if chain[index] is not filtering:
        return "Waveform filtering must precede rereferencing, resampling, and normalization"
    index += 1
    if names[0] == "context_window":
        if index >= len(chain) or names[index] != "crop_to_target_window":
            return "Waveform context must be cropped back to the target window before downstream stages"
        index += 1
    referenced = False
    normalizing = False
    for stage in chain[index:]:
        name = stage["name"]
        if name == "laplacian_rereference" and not normalizing:
            if not _flag(stage, "remove_non_laplacian"):
                return "Waveform requires removal of non-Laplacian channels"
            referenced = True
        elif name in {"resample", "downsample", "upsampler"} and not normalizing:
            source, target = (
                _integer(stage, "source_rate"),
                _integer(stage, "target_rate"),
            )
            if source != rate:
                return (
                    "Resampling source_rate does not match the preceding waveform rate"
                )
            rate = target
        elif name == "standardize" and referenced:
            if stage.get("mode", "per_channel_feature") not in NORMALIZATION_MODES:
                return "Unknown waveform normalization mode"
            normalizing = True
        else:
            return f"Unsupported waveform stage/order: {name}"
    return None


def classify_preprocessing(chain: list[dict]) -> tuple[str, str]:
    """Return (stored track ID, explanation); malformed configs raise ValueError."""
    if not isinstance(chain, list) or not chain:
        raise ValueError("Preprocessing chain must be a non-empty list")
    for stage in chain:
        if (
            not isinstance(stage, dict)
            or not isinstance(stage.get("name"), str)
            or not stage["name"].strip()
        ):
            raise ValueError("Every preprocessing stage must have a non-empty name")
    for stage in chain:
        name = stage["name"]
        if name in {"stft", "laplacian_stft", "brainbert_encoder"}:
            return (
                "Other",
                "Single-STFT/BrainBERT is a custom route, not the Multi-STFT track",
            )
        if name not in STAGE_FIELDS:
            return "Other", f"Unrecognized preprocessing stage: {name}"
        unknown = set(stage) - STAGE_FIELDS[name] - {"name"}
        if unknown:
            return (
                "Other",
                f"Unrecognized {name} settings: {', '.join(sorted(unknown))}",
            )
        if name == "standardize":
            mode = stage.get("mode", "per_channel_feature")
            if not isinstance(mode, str) or not mode.strip():
                raise ValueError("standardize.mode must be a non-empty string")
            if _number(stage, "eps", 1e-8) <= 0:
                raise ValueError("standardize.eps must be positive")
            if mode in {
                "per_channel_feature",
                "per_channel_samples_time_pooled",
            } and stage.get("unseen_channel_policy", "global_fallback") not in (
                "global_fallback",
                "error",
            ):
                raise ValueError(
                    "standardize.unseen_channel_policy must be global_fallback or error"
                )
            if mode == "global_robust_scalar":
                _integer(stage, "robust_reservoir_size", 1_000_000)
    if any(stage["name"] == "multi_stft" for stage in chain):
        reason = _spectral_reason(chain)
        return (
            ("Other", reason)
            if reason
            else ("STFT", "Matches the standardized Multi-STFT recipe")
        )
    reason = _waveform_reason(chain)
    return (
        ("Other", reason)
        if reason
        else ("WAV", "Matches the Waveform track requirements")
    )
