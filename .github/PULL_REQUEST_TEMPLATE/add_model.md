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

Paste the `coverage:` and `cohort:` lines printed by the `--dry-run` report:

```text

```

A submission is expected to cover the full benchmark grid. If it cannot, the
only accepted fallback is exactly the Main or exactly the Challenge cohort,
using the same choice for every preprocessing entry. If this is a cohort
submission, name the cohort in `coverage_note`.
The leaderboard generates its own footnote about the missing cells and appends
`coverage_note` to it; the note cannot replace that text, and it is dropped
entirely on a full-grid submission.

## Model details

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
- [ ] The generated `data_bundle.js` is included.
- [ ] Committed only `data/submissions/<model_id>.json`,
      `data/models/<model_id>.json`, `data/manifest.json`, and `data_bundle.js`.
- [ ] No caches, temporary files, or private author/contact metadata are included.
- [ ] Inspected the diff and confirmed no unrelated model artifact changed.
- [ ] `data/coverage_contract.json` and the decodable-subject manifests are
      unchanged (or the change to the reviewed benchmark definition is
      explained above).

Full reference: [`leaderboard/README.md`](../../leaderboard/README.md).
