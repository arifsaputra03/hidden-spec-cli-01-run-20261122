# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun · hidden-spec-cli-01-run-20261122 rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arifsaputra03/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun · hidden-spec-cli-01-run-20261122 reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arifsaputra03/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format.

`mend` reads a patch — a unified diff (with possibly wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or JSON tool calls — finds the lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive, leading-and-trailing-whitespace-insensitive), and writes every change or none, printing what it changed or why it failed.

## Usage

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is a patch file, or `-` (or omitted) to read the patch from stdin.
- `--format=auto|unified|search-replace|v4a|json` (default `auto`): the patch format. With `auto` the format is detected from the patch text.
- `--check`: print what would change, but write nothing.
- `--strict`: only the exact tier matches.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R <old> -> <new>` for a move) and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`, and writes nothing. Exit 2 is a usage, format, or parse error.

Node 22, standard library only. Deterministic: the same check gives the same exit code, stdout, and files every run.

Built for the make.fun bounty [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
