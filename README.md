# mend

[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/BeastOrange/mend-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/BeastOrange/mend-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a robust command-line patch tool that applies AI-generated edits across four formats: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits. It features three-tier fuzzy line matching, precise newline and whitespace preservation, and all-or-nothing atomic writes.

## Usage

```bash
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- Options:
  - `--format=NAME`: specify format (`unified`, `search-replace`, `v4a`, `json`, or `auto` by default).
  - `--check`: dry run — test application without writing changes to disk.
  - `--strict`: disable fuzzy whitespace matching (tier 0 exact match only).
  - `PATCH`: path to the patch file, or `-` (or omit) for standard input.
