# iMINDBench Leaderboard


## View the leaderboard locally

Use the local server, which serves only files contained in this `leaderboard/`
directory:

```bash
cd examples/neuroprobe_eval/leaderboard
python serve.py --port 8080
```

Then open <http://localhost:8080>.

## Validate the checked-in data

Run the validator before submitting a leaderboard change:

```bash
cd examples/neuroprobe_eval/leaderboard
python validate_data.py
```

Validation uses only checked-in files. It checks the manifest, every visible or
unpublished model
artifact, run references, record uniqueness, the benchmark coverage contract,
and the decodable-subject manifests. It does not require raw evaluation outputs.
CI runs this same validation, so a local success should match the repository
check.

## Generate the baseline

Regenerate all baseline model artifacts from an explicitly supplied external
raw-output directory:

```bash
cd examples/neuroprobe_eval/leaderboard
python generate_data.py \
  --outputs-dir /path/to/jul21_arxiv_leaderboard
```

`--outputs-dir` is required; the leaderboard does not assume a sibling
`outputs/` directory. The checked-in destination defaults are:

```text
--models-dir data/models
--manifest data/manifest.json
--coverage-contract data/coverage_contract.json
--submissions-dir data/baseline_submissions
--submissions-dir data/submissions
```

The external raw baseline directory is never copied into the leaderboard.
Generation partitions it by model, validates all proposed artifacts before
writing, and does not remove checked-in models that are absent from the input.

Preview a regeneration without changing files:

```bash
python generate_data.py \
  --outputs-dir /path/to/jul21_arxiv_leaderboard \
  --dry-run
```

If a generated artifact differs from an existing artifact, the command stops
without writing. After reviewing the reported changes, explicitly authorize the
replacement with:

```bash
python generate_data.py \
  --outputs-dir /path/to/jul21_arxiv_leaderboard \
  --overwrite
```

You can combine `--dry-run --overwrite` to preview what an authorized replacement
would do. Custom source and destination paths can be supplied with the options
shown above.

## Add a model

Keep raw evaluation outputs outside `leaderboard/`. Replace `example_model` with
the same stable model ID in the external output directory and both checked-in
files:

```text
/path/to/evaluation_outputs/
  example_model/                      # external population_*.json results

leaderboard/
  data/
    submissions/
      example_model.json              # public model metadata you create
    models/
      example_model.json              # generated publication artifact
```

Place the complete raw evaluation output in an external directory, then create
`data/submissions/example_model.json`:

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

`model_id` must be a stable lowercase underscore-separated slug. Set
`pretrained_on` to `null` when `pretrained` is `false`. Unknown fields and a model
ID that disagrees with the raw results are rejected.

Preview the submission first:

```bash
cd examples/neuroprobe_eval/leaderboard
python add_model.py \
  --model-outputs /path/to/evaluation_outputs/example_model \
  --submission data/submissions/example_model.json \
  --dry-run
```

The report includes physical run configurations, logical leaderboard entries,
unique result cells, fold records, and missing coverage by dataset. The coverage
grid comes from `data/coverage_contract.json`; it is not inferred from other
models.

Add the model after reviewing the report:

```bash
python add_model.py \
  --model-outputs /path/to/evaluation_outputs/example_model \
  --submission data/submissions/example_model.json
```

This creates `data/models/example_model.json` and adds its sorted path to
`data/manifest.json`. Re-running with identical inputs is an unchanged no-op.
Entries under `unpublished_models` are validated but are not loaded by the browser.

## Update an existing model

An existing artifact is never replaced implicitly. Preview the complete
replacement and its before/after summary:

```bash
python add_model.py \
  --model-outputs /path/to/evaluation_outputs/example_model \
  --submission data/submissions/example_model.json \
  --dry-run \
  --overwrite
```

Then apply it explicitly:

```bash
python add_model.py \
  --model-outputs /path/to/evaluation_outputs/example_model \
  --submission data/submissions/example_model.json \
  --overwrite
```

The supplied output directory is the model's complete intended submission, not
a partial patch. A differing existing artifact fails without `--overwrite`, and
`--dry-run` never writes.

## Coverage behavior

Coverage is computed separately for each logical preprocessing entry. A complete
entry contains the expected tasks, subject/session cells, and fold indices for
all benchmark datasets.

Partial coverage is allowed. It is stored as `coverage.status: "partial"` and is
shown automatically in the browser. An optional `coverage_note` may explain the
gap, but it cannot hide or override computed partial status.

Missing benchmark cells make coverage partial; they do not make the command
fail. Malformed records, duplicate cells or folds, missing expected fold indices,
unexpected benchmark cells, and a stored coverage summary that disagrees with
the records are validation errors.

## Files to commit

For a new model, commit:

- `data/submissions/<model_id>.json`
- `data/models/<model_id>.json`
- `data/manifest.json`

For an update to an already-listed model, normally only
`data/models/<model_id>.json` changes. Commit `data/coverage_contract.json` only
when intentionally changing the reviewed benchmark definition, and commit
decodable-subject manifests only when intentionally updating their authoritative
filters or rooflines.

Do not copy raw evaluation outputs into `leaderboard/`, and do not commit
temporary files, generated caches, or private author/contact metadata. Before
opening a change, run `python validate_data.py` and inspect the Git diff to
confirm that no unrelated model artifact changed.


## Main vs Challenge subjects

The **Subjects** filter splits subject-sessions into `Main` (decodable) and
`Challenge` (not decodable). The leaderboard uses one fixed decodability rule:
`max(STFT, HTNet 500Hz)` mean validation ROC-AUC greater than 0.60. Its
per-dataset manifests are checked in under
`decodable_subject_sessions/stft_or_htnet_500hz_val_mean0p60/`.

The cohort cannot be selected in the UI or overridden through a URL query
parameter. Changing the authoritative rule requires updating the in-folder
manifests together with the corresponding loader, validator, and documentation.

Only `subject_sessions` and `n_subject_sessions` are required per task; the
roofline fields (`mean_test_roc_auc`, `max_test_roc_auc`) are optional and the
validation-based manifests omit them.

## Self-contained layout

All files needed to serve, view, and validate the checked-in leaderboard live
under `leaderboard/`:

```text
leaderboard/
  app.js
  index.html
  style.css
  serve.py
  validate_data.py
  data/                              # manifest, contracts, submissions, models
  decodable_subject_sessions/
    stft_or_htnet_500hz_val_mean0p60/
```

Raw evaluation results are intentionally not part of this layout. Commands that
ingest them require an explicit external path: `generate_data.py --outputs-dir`
and `add_model.py --model-outputs`.
