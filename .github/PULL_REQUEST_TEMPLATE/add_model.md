## Model

- **Model ID** (`model_id`, lowercase underscore-separated slug):
- **Display name**:
- **Pretrained**: yes / no
- **Pretrained on** (`null` when not pretrained):

## Submission file

Paste the contents of `leaderboard/data/submissions/<model_id>.json`:

```json
{
  "schema_version": 1,
  "model_id": "",
  "display_name": "",
  "pretrained": true,
  "pretrained_on": "",
  "description": "",
  "coverage_note": null
}
```

## Coverage

Paste the `coverage:` lines printed by the `--dry-run` report:

```text

```

If the status is `partial`, explain the gap here and in `coverage_note`. The
leaderboard generates its own footnote about the missing cells and appends
`coverage_note` to it; the note cannot replace that text, and it is dropped
entirely when coverage is complete.

## Provenance

- **Paper / preprint**:
- **Code**:
- **Checkpoint availability**:
- **Were any benchmark subject-sessions used during pretraining?**

## Checklist

- [ ] Raw evaluation outputs live outside `leaderboard/` and are not committed.
- [ ] Previewed the submission:
      `python add_model.py --model-outputs /path/to/outputs/<model_id> --submission data/submissions/<model_id>.json --dry-run`
- [ ] Applied it:
      `python add_model.py --model-outputs /path/to/outputs/<model_id> --submission data/submissions/<model_id>.json`
- [ ] `python validate_data.py` passes.
- [ ] Committed only `data/submissions/<model_id>.json`,
      `data/models/<model_id>.json`, and `data/manifest.json`.
- [ ] No caches, temporary files, or private author/contact metadata are included.
- [ ] Inspected the diff and confirmed no unrelated model artifact changed.
- [ ] `data/coverage_contract.json` and the decodable-subject manifests are
      unchanged (or the change to the reviewed benchmark definition is
      explained above).

Full reference: [`leaderboard/README.md`](../../leaderboard/README.md).
