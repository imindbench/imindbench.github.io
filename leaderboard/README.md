# iMINDBench Leaderboard

Checked-in data, the browser app, and the tooling that validates both. Raw
evaluation outputs live outside this directory; every command that reads them
takes an explicit external path.

## View it locally

Download the repository and open its root `index.html` directly. The generated
`data_bundle.js` lets the leaderboard load under `file://` without a server.

To test through HTTP instead, serve the repository root, not this directory:

```bash
python3 -m http.server 8899 --bind 127.0.0.1
```

Then open <http://localhost:8899/leaderboard/>.

## Add a model

Give the model a stable ID: a lowercase underscore-separated slug used for the
external output directory and both checked-in files.

```text
/path/to/evaluation_outputs/
  example_model/                      # external population_*.json results

leaderboard/data/
  submissions/example_model.json      # public metadata you write
  models/example_model.json           # generated publication artifact
```

Write `data/submissions/example_model.json`:

```json
{
  "schema_version": 1,
  "model_id": "example_model",
  "display_name": "Example Model",
  "pretrained": true,
  "pretrained_on": "Public Dataset",
  "description": "Short public description of the evaluated model.",
  "coverage_note": null
}
```

`pretrained_on` must be `null` when `pretrained` is `false`, and
`coverage_note` is either `null` or a non-empty string. Unknown fields, and a
model ID that disagrees with the raw results, are rejected.

The importer accepts `config.preprocess` (or the historical `config.preprocessor`)
as an ordered `chain` of named stages, or a single named stage. An overall chain
`name` is not required. Historical overall names are retained only for display;
they cannot select a track. Keep raw outputs in the existing
`dataset/[subset/]run/regime/task/subject_session/population_*.json` hierarchy
under the model output directory. PIPPI uses subset `high-cov`. When staging
outputs from iMINDBench's dataset scripts, omit their extra `within_session/`
output-group directory. Filename-based row grouping is unchanged by track
classification.

Preview, apply, then validate, all from `leaderboard/`:

```bash
python add_model.py \
  --model-outputs /path/to/evaluation_outputs/example_model \
  --submission data/submissions/example_model.json \
  --dry-run

python add_model.py \
  --model-outputs /path/to/evaluation_outputs/example_model \
  --submission data/submissions/example_model.json

python validate_data.py
```

The dry run reports physical run configurations, logical leaderboard entries,
fold records, and a `coverage: observed/expected (status)` line per
preprocessing entry, with missing cells broken down by dataset. Its coverage
grid comes from `data/coverage_contract.json` and is never inferred from other
models.

The report also lists the config-derived track and its explanation for each run.
Check these lines before applying the submission, especially Custom routes.

Applying writes `data/models/example_model.json`, adds its sorted path to
`data/manifest.json`, and refreshes the generated `data_bundle.js` used by
browsers. Re-running with identical inputs is a no-op. Paths listed
under `unpublished_models` are validated but not loaded by the browser.

Commit exactly four files:

- `data/submissions/<model_id>.json`
- `data/models/<model_id>.json`
- `data/manifest.json`
- `data_bundle.js`

Never commit raw evaluation outputs, caches, temporary files, or private
author and contact metadata, and check the diff for unrelated model artifacts.
Change `data/coverage_contract.json` only when intentionally revising the
reviewed benchmark definition, and the decodable-subject manifests only when
intentionally updating their filters or rooflines.

Then open a pull request with the
[submission template](../.github/PULL_REQUEST_TEMPLATE/add_model.md). The
public version of these instructions is [`submit.html`](submit.html).

## Update a listed model

An existing artifact is never replaced implicitly. The supplied output
directory is the model's complete intended submission, not a partial patch.

```bash
python add_model.py \
  --model-outputs /path/to/evaluation_outputs/example_model \
  --submission data/submissions/example_model.json \
  --dry-run --overwrite
```

Review the before/after summary, then drop `--dry-run` to apply it. A differing
existing artifact fails without `--overwrite`; `--dry-run` never writes. For an
update, normally `data/models/<model_id>.json` and `data_bundle.js` change.

## Validate

```bash
python validate_data.py
```

Checks the manifest, every visible and unpublished artifact, run references,
record uniqueness, the benchmark coverage contract, the decodable-subject
manifests, the cohort rule, and every submission file, using only checked-in
files. It also verifies that `data_bundle.js` exactly matches its canonical JSON
inputs. Submissions and artifacts must correspond one-to-one, and an artifact's
`model` block must match its submission file, so hand-editing one without the
other fails.

[`.github/workflows/validate-leaderboard.yml`](../.github/workflows/validate-leaderboard.yml)
runs this same command on every pull request, so a local pass should match the
repository check.

## Preprocessing tracks

Track eligibility is computed from the ordered stages and their effective
parameters by `preprocessing_tracks.py`, both when importing raw outputs and
when validating the committed artifacts. Editing `preprocessing_track` by hand
without a matching config fails validation. The browser displays **Multi-STFT**,
**Waveform**, and **Custom**; stored IDs and URL filters remain `STFT`, `WAV`, and
`Other` for compatibility. Coverage and cohort requirements apply to all tracks.
All runs grouped into one displayed row must qualify for the same track.

The paper defines Multi-STFT using line-noise notch filtering, Laplacian
rereferencing, three frequency resolutions, and training-fitted per-channel,
per-frequency normalization. Automatic admission currently recognizes the
following canonical recipe:

- Exactly `time_domain_filter` → `laplacian_rereference` → `multi_stft` →
  `standardize`, with no added transforms.
- Standard notches at 60, 120, 180, 240, 300, and 360 Hz below Nyquist; no
  high-pass or high-gamma bandpass. The supported recipe uses per-window causal
  notch filtering with Q=30 and drops non-Laplacian channels.
- Matching filter/STFT rates of 1000 or 2048 Hz. Ordered low/mid/high bands are
  2–40, 20–150, and 80–250 Hz. Window durations are 0.5, 0.25, and 0.125 seconds;
  exact sample counts are 500/250/125 or 1024/512/256. Hops are 62 or 128 samples,
  respectively; no task-specific window selection is admitted.
- Hann windows, reflection padding, no additional padding, clipping or internal
  z-scoring, float32 STFT computation, and final
  `standardize.mode: per_channel_samples_time_pooled` with `eps: 1e-8`.
  Per-window overrides are inspected as well as top-level settings.

The exact padding, window, Q, and execution options above describe the supported
canonical implementation; they are not additional claims about what the paper
text specifies. Unrecognized variations are Custom pending review. In particular,
single-STFT, BrainBERT representations, and sample-normalized Multi-STFT do not
qualify for the standardized Multi-STFT track.

The Waveform track requires a **0.5 Hz** high-pass filter, line-noise notches,
Laplacian rereferencing with non-Laplacian channels removed, and waveform inputs:

- Recognized filters are `time_domain_filter` with the standard harmonic notches
  and `time_domain_filter_diver_style` with 60/120/180 Hz notches. High-gamma
  bandpass filtering is excluded.
- Optional context is loaded before filtering and cropped back to the target
  before rereferencing/resampling. Resampling may precede or follow Laplacian
  rereferencing, accommodating BaRISTA. Rate declarations must agree throughout.
- Supported waveform normalization modes and sampling rates may vary, as allowed
  by the paper. This includes robust scaling, sample normalization, their
  composition, and no additional normalization. Historical `downsample` and
  `upsampler` stages are recognized alongside `resample`.
- Spectral transforms, unknown stages/settings, and unsupported stage ordering
  are Custom. Same-track membership does not imply identical inputs: the
  standardized baseline, BaRISTA, and DIVER remain distinct recipes.

Historical defaults are implementation-specific: omitted standard-filter
`high_pass_hz` means 0.0; omitted or null DIVER `high_pass_hz` means 0.5. Omitted
notch lists use the corresponding frequencies above. Standard-filter null HP
values and malformed stage/numeric fields are errors, not an alternate recipe.
Explicit no-HPF waveform configs are Custom. A config outside a recognized recipe
is explained in the submission report, not silently promoted based on its name.

Custom routes should document preprocessing and provide a compatible simple
baseline where possible, following the paper's custom-route guidance. Config
checks verify declared eligibility, not truthful execution, training-only fitting,
or score reproducibility. The evaluator remains responsible for those behaviors.

Run importer/eligibility regression tests from the repository root with
`python -m unittest discover -s tests -v`; CI runs them with artifact validation.

## Coverage behavior

Coverage is computed separately for each logical preprocessing entry. A
complete entry contains the expected tasks, subject/session cells, and fold
indices for all benchmark datasets.

A submission is expected to cover the full benchmark grid. If it cannot, the
only accepted fallback is covering exactly the `Main` or exactly the
`Challenge` cohort, using the same choice for every logical entry of the model.
Any other subset is rejected, because an average over an arbitrary set of
subject-sessions cannot be compared with the other rows of the leaderboard.
`add_model.py` prints the classification it derives from the
decodable-subject manifests described below.

Missing benchmark cells make coverage `partial`; they do not fail the command.
The browser then shows an automatic footnote counting the missing result cells
and appends `coverage_note` to it, so the note can explain a gap but cannot
replace or suppress the generated text. On a complete model the note is dropped
and never displayed.

Malformed records, duplicate cells or folds, missing expected fold indices,
unexpected benchmark cells, and a stored coverage summary that disagrees with
the records are all validation errors.

## Main vs Challenge subjects

The **Subjects** filter splits subject-sessions into `Main` (decodable) and
`Challenge` (not decodable) using one fixed rule: `max(STFT, HTNet 500Hz)` mean
validation ROC-AUC greater than 0.60. The per-dataset manifests are checked in
under `decodable_subject_sessions/stft_or_htnet_500hz_val_mean0p60/`. The same
manifests define the admissible cohorts above, so every listed session must also
appear in the coverage contract.

Only `subject_sessions` and `n_subject_sessions` are required per task; the
roofline fields (`mean_test_roc_auc`, `max_test_roc_auc`) are optional and the
validation-based manifests omit them.

The cohort cannot be selected in the UI or through a URL parameter. Changing
the authoritative rule means updating the in-folder manifests together with the
loader, the validator, and this document.

## Regenerate the baseline

Rebuild all baseline artifacts from an external raw-output directory.
`--outputs-dir` is required; no sibling `outputs/` directory is assumed.

```bash
python generate_data.py --outputs-dir /path/to/jul21_arxiv_leaderboard --dry-run
```

Destinations default to `data/models`, `data/manifest.json`,
`data/coverage_contract.json`, and two submission sources
(`data/baseline_submissions` and `data/submissions`, overridable with repeated
`--submissions-dir` flags). The browser bundle defaults beside the selected
data directory and can be overridden with `--data-bundle`.

Generation partitions the input by model, validates every proposed artifact
before writing, and leaves checked-in models absent from the input alone. If a
generated artifact differs from an existing one the command stops; re-run with
`--overwrite` to authorize the replacement, optionally with `--dry-run` first.
The external directory is never copied into `leaderboard/`.

## Layout

```text
.github/workflows/                   # CI: runs validate_data.py on every PR

leaderboard/
  index.html                         # the leaderboard app
  submit.html                        # public submission guide
  app.js
  data_bundle.js                     # generated browser-readable data
  style.css
  add_model.py                       # add or update one model
  build_data_bundle.py               # rebuild/check the browser data bundle
  generate_data.py                   # rebuild all baseline artifacts
  validate_data.py
  leaderboard_data.py                # shared schema and validation
  data/                              # manifest, contract, submissions, models
  decodable_subject_sessions/
    stft_or_htnet_500hz_val_mean0p60/
```

Both pages also load `../assets/theme.css` and `../assets/theme.js`, the design
tokens shared with the homepage.
