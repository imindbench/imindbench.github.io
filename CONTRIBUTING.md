# Contributing

A leaderboard submission is a pull request that adds one model's public
metadata and its generated publication artifact. Raw evaluation outputs stay
outside this repository; the tooling reads them from an explicit external path.

From `leaderboard/`, with the complete raw output for your model in an external
directory and `data/submissions/<model_id>.json` written:

```bash
python add_model.py \
  --model-outputs /path/to/evaluation_outputs/<model_id> \
  --submission data/submissions/<model_id>.json \
  --dry-run

python add_model.py \
  --model-outputs /path/to/evaluation_outputs/<model_id> \
  --submission data/submissions/<model_id>.json

python validate_data.py
```

Commit only:

- `leaderboard/data/submissions/<model_id>.json`
- `leaderboard/data/models/<model_id>.json`
- `leaderboard/data/manifest.json`
- `leaderboard/data_bundle.js`

Then open a pull request using the
[model submission template](.github/PULL_REQUEST_TEMPLATE/add_model.md):

<https://github.com/imindbench/imindbench.github.io/compare?expand=1&template=add_model.md>

[`leaderboard/README.md`](leaderboard/README.md) is the full reference for the
submission schema, coverage behavior, updating an already-listed model, and
viewing the site locally.
